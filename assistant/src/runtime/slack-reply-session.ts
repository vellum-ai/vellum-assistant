import type { SlackStreamTask } from "@vellumai/gateway-client";

import {
  extractThreadTsFromCallbackUrl,
  isSlackDeliveryCallbackUrl,
} from "../channels/slack-thread-store.js";
import type { ChannelId } from "../channels/types.js";
import {
  incompleteVellumLinkSuffixLength,
  stripVellumLinks,
} from "../daemon/assistant-attachments.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { SLACK_STREAM_MARKDOWN_LIMIT } from "../messaging/providers/slack/api.js";
import { renderSlackBlocks } from "../messaging/providers/slack/render.js";
import { getLogger } from "../util/logger.js";
import { needsBoundarySpace } from "../util/text-spacing.js";
import { deliverChannelReply } from "./gateway-client.js";
import {
  hasDeliverableAssistantText,
  NO_RESPONSE_INLINE_RE,
} from "./no-response.js";
import type { TaskProgressData } from "./slack-task-progress.js";
import {
  getTaskProgressDataFromSurfaceData,
  mergeTaskProgressData,
  toSlackStreamTasks,
} from "./slack-task-progress.js";

const log = getLogger("slack-reply-session");

/**
 * Minimum gap between coalesced `appendStream` calls. `chat.appendStream` is a
 * Tier 4 method (100+ req/min); debouncing deltas keeps well under that while
 * still feeling live.
 *
 * @see https://docs.slack.dev/reference/methods/chat.appendStream/
 */
const STREAM_COALESCE_MS = 400;

/**
 * How durable finalize should reconcile against the streaming session.
 *
 * - `streamed`: the reply was delivered live into a single streamed message;
 *   finalize skips re-posting text, reconciles `slackMeta.channelTs` to the
 *   stream `ts`, and posts only attachments.
 * - `fallback`: no stream was opened (ineligible turn, no deliverable text, or
 *   a failed `startStream`); finalize posts the full reply normally.
 */
export type SlackStreamReconciliation =
  | { mode: "streamed"; messageTs: string; deliveredSegmentCount: number }
  | { mode: "fallback" };

export type SlackReplySession = {
  observeEvent: (msg: ServerMessage) => void;
  /**
   * Settle in-flight stream operations, finalize the stream, and report how
   * durable delivery should reconcile. Call once after processing completes.
   */
  finish: () => Promise<SlackStreamReconciliation>;
};

/**
 * Whether a turn is eligible for native Slack reply streaming. Every eligible
 * turn resolves to a threaded reply, since `chat.startStream` requires a
 * `thread_ts`. Assistant-container DMs carry that thread implicitly; channel
 * turns (including app-mention threads) thread under the inbound message.
 *
 * DMs infer the reader, so they stream without recipient identity. Channels
 * must name the reader: `chat.startStream` requires both `recipient_user_id`
 * and `recipient_team_id`, so a channel turn missing either falls back to
 * durable delivery.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream/
 */
export function shouldStreamSlackReply(params: {
  sourceChannel: ChannelId;
  chatType?: string;
  replyCallbackUrl?: string;
  recipientUserId?: string;
  recipientTeamId?: string;
}): boolean {
  if (params.sourceChannel !== "slack") return false;
  if (!isSlackDeliveryCallbackUrl(params.replyCallbackUrl)) return false;
  if (extractThreadTsFromCallbackUrl(params.replyCallbackUrl) === null) {
    return false;
  }
  if (params.chatType === "im") return true;
  return Boolean(params.recipientUserId && params.recipientTeamId);
}

type StreamState = "idle" | "streaming" | "fallback";

/**
 * Owns the live-content lifecycle of one Slack DM reply: it consumes the
 * assistant token stream once, opens a streamed message (in plan display
 * mode) on first deliverable text, coalesces deltas into `appendStream`
 * calls, advances a native plan block from `task_progress` surfaces, and
 * finalizes with `stopStream`.
 *
 * Any stream-call failure degrades gracefully: the session abandons streaming
 * (state `fallback`) and reports back so durable finalize posts the full reply
 * via the normal path. Returns `undefined` for turns that are not eligible to
 * stream.
 */
export function createSlackReplySession(params: {
  sourceChannel: ChannelId;
  chatType?: string;
  replyCallbackUrl?: string;
  chatId: string;
  assistantId?: string;
  /** Slack user ID of the reader; required to stream into a channel. */
  recipientUserId?: string;
  /** Slack team ID of the reader; required to stream into a channel. */
  recipientTeamId?: string;
  /** Gap between coalesced `appendStream` calls. Defaults to {@link STREAM_COALESCE_MS}. */
  coalesceMs?: number;
}): SlackReplySession | undefined {
  if (!shouldStreamSlackReply(params) || !params.replyCallbackUrl) {
    return undefined;
  }
  const { chatId, assistantId, recipientUserId, recipientTeamId } = params;
  const coalesceMs = params.coalesceMs ?? STREAM_COALESCE_MS;
  const replyCallbackUrl = params.replyCallbackUrl;
  const threadTs = extractThreadTsFromCallbackUrl(replyCallbackUrl);
  if (threadTs === null) return undefined;

  let state: StreamState = "idle";
  let started = false;
  let finished = false;
  let streamTs: string | undefined;

  let rawText = "";
  let confirmedLength = 0;

  let segmentBuffer = "";
  let deliveredSegmentCount = 0;
  // Set when a tool-call or message boundary closes a text segment: the next
  // segment's first delta is a fresh model response, so it is spaced off the
  // prior segment when the model omitted the separating whitespace (matching
  // `renderHistoryContent`'s `joinWithSpacing` on the durable delivery path).
  let pendingSegmentBoundary = false;

  const taskProgressBySurfaceId = new Map<string, TaskProgressData>();
  let activeProgress: TaskProgressData | undefined;
  // Fingerprint of the plan state last delivered to Slack, so progress that
  // advances without new body text still flushes as a task-only append.
  let deliveredProgressKey: string | undefined;
  // Set once a chunks-only append is rejected (e.g. a Slack tier that
  // requires `markdown_text` on every append): the session stops attempting
  // them and progress rides the next text append or `stopStream` instead,
  // so a rejecting workspace pays one failed call per turn, not one per
  // progress update.
  let taskOnlyAppendsDisabled = false;

  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let opChain: Promise<void> = Promise.resolve();

  const cleanedText = (): string =>
    stripVellumLinks(rawText).replace(NO_RESPONSE_INLINE_RE, "");

  // Text safe to append to Slack's append-only stream: while more deltas may
  // arrive, a trailing `[label](vellum://…)` link that is still being assembled
  // is withheld so its internal path is never emitted before the link closes
  // (and `stripVellumLinks` can remove it). Once `finished`, no delta can
  // extend the text, so the full cleaned reply is safe to emit.
  const streamableText = (): string => {
    if (finished) return cleanedText();
    const hold = incompleteVellumLinkSuffixLength(rawText);
    const stable = hold > 0 ? rawText.slice(0, rawText.length - hold) : rawText;
    return stripVellumLinks(stable).replace(NO_RESPONSE_INLINE_RE, "");
  };

  const planTasks = (): SlackStreamTask[] | undefined =>
    activeProgress ? toSlackStreamTasks(activeProgress) : undefined;

  const progressKey = (
    title: string | undefined,
    tasks: SlackStreamTask[] | undefined,
  ): string | undefined =>
    tasks ? JSON.stringify({ title, tasks }) : undefined;

  const imageBlocks = (
    text: string,
  ):
    | NonNullable<Parameters<typeof deliverChannelReply>[1]["blocks"]>
    | undefined => {
    const blocks = renderSlackBlocks(text)?.filter(
      (block) => block.type === "image",
    );
    return blocks && blocks.length > 0 ? blocks : undefined;
  };

  const enqueue = (op: () => Promise<void>): void => {
    opChain = opChain.catch(() => undefined).then(op);
  };

  const enqueueStart = (): void => {
    enqueue(async () => {
      const clean = streamableText();
      if (clean.trim().length === 0) return;
      const firstChunk = clean.slice(0, SLACK_STREAM_MARKDOWN_LIMIT);
      const title = activeProgress?.title;
      const tasks = planTasks();
      try {
        const result = await deliverChannelReply(replyCallbackUrl, {
          chatId,
          assistantId,
          slackStream: {
            action: "start",
            threadTs,
            markdownText: firstChunk,
            // The task display mode is fixed for the stream's lifetime at
            // start, while a `task_progress` surface usually appears only
            // after the first text flush has opened the stream. Plan mode
            // only affects how task chunks render, so a stream that never
            // carries tasks still reads as a plain message.
            taskDisplayMode: "plan" as const,
            ...(title ? { planTitle: title } : {}),
            ...(tasks ? { tasks } : {}),
            ...(recipientUserId ? { recipientUserId } : {}),
            ...(recipientTeamId ? { recipientTeamId } : {}),
          },
        });
        if (result.ok && result.ts) {
          streamTs = result.ts;
          confirmedLength = firstChunk.length;
          deliveredProgressKey = progressKey(title, tasks);
          state = "streaming";
        } else {
          state = "fallback";
        }
      } catch (err) {
        log.warn({ err, chatId }, "Slack startStream failed; falling back");
        state = "fallback";
      }
    });
    enqueueAppend();
  };

  const enqueueAppend = (): void => {
    enqueue(async () => {
      if (state !== "streaming" || !streamTs) return;
      const clean = streamableText();
      const title = activeProgress?.title;
      const tasks = planTasks();
      const key = progressKey(title, tasks);
      // `chat.appendStream` caps `markdown_text` per call, so a delta wider
      // than the limit drains across successive append calls. Each append
      // carries the current task state, advancing the plan alongside text.
      while (confirmedLength < clean.length) {
        const chunk = clean.slice(
          confirmedLength,
          confirmedLength + SLACK_STREAM_MARKDOWN_LIMIT,
        );
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId,
            assistantId,
            slackStream: {
              action: "append",
              streamTs,
              markdownText: chunk,
              ...(title ? { planTitle: title } : {}),
              ...(tasks ? { tasks } : {}),
            },
          });
          confirmedLength += chunk.length;
          deliveredProgressKey = key ?? deliveredProgressKey;
        } catch (err) {
          log.warn(
            { err, chatId },
            "Slack appendStream failed; deferring delta",
          );
          return;
        }
      }
      // Progress that advances without new body text still lands live:
      // `chat.appendStream` accepts a chunks-only call, so the plan block
      // ticks during tool work instead of waiting for the next text append.
      // A failure disables further task-only appends for the session; the
      // unchanged fingerprint leaves the update pending, so it rides the
      // next text append and `stopStream` carries the final state.
      if (!taskOnlyAppendsDisabled && tasks && key !== deliveredProgressKey) {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId,
            assistantId,
            slackStream: {
              action: "append",
              streamTs,
              ...(title ? { planTitle: title } : {}),
              tasks,
            },
          });
          deliveredProgressKey = key;
        } catch (err) {
          taskOnlyAppendsDisabled = true;
          log.warn(
            { err, chatId },
            "Slack task-only appendStream failed; deferring progress to text appends",
          );
        }
      }
    });
  };

  const flush = (): void => {
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = undefined;
    }
    if (finished || state === "fallback") return;
    if (!started) {
      if (!hasDeliverableAssistantText(streamableText())) return;
      started = true;
      enqueueStart();
      return;
    }
    enqueueAppend();
  };

  const scheduleFlush = (): void => {
    if (coalesceTimer || finished) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      flush();
    }, coalesceMs);
    (coalesceTimer as { unref?: () => void }).unref?.();
  };

  const countSegmentBoundary = (): void => {
    const segment = segmentBuffer;
    segmentBuffer = "";
    if (segment.replace(NO_RESPONSE_INLINE_RE, "").trim().length > 0) {
      deliveredSegmentCount += 1;
    }
  };

  const observeTaskProgress = (msg: ServerMessage): void => {
    if (msg.type === "ui_surface_show") {
      const progress = getTaskProgressDataFromSurfaceData(msg.data);
      if (!progress) return;
      taskProgressBySurfaceId.set(msg.surfaceId, progress);
    } else if (msg.type === "ui_surface_update") {
      const existing = taskProgressBySurfaceId.get(msg.surfaceId);
      const progress = mergeTaskProgressData(existing, msg.data);
      if (!progress) return;
      taskProgressBySurfaceId.set(msg.surfaceId, progress);
    } else {
      return;
    }
    activeProgress = taskProgressBySurfaceId.get(msg.surfaceId);
    scheduleFlush();
  };

  return {
    observeEvent(msg) {
      if (finished) return;

      if (msg.type === "ui_surface_show" || msg.type === "ui_surface_update") {
        observeTaskProgress(msg);
        return;
      }
      if (msg.type === "assistant_text_delta") {
        if (pendingSegmentBoundary && msg.text.length > 0) {
          if (needsBoundarySpace(rawText, msg.text)) {
            rawText += " ";
          }
          pendingSegmentBoundary = false;
        }
        rawText += msg.text;
        segmentBuffer += msg.text;
        scheduleFlush();
        return;
      }
      if (msg.type === "tool_use_start" || msg.type === "message_complete") {
        countSegmentBoundary();
        pendingSegmentBoundary = true;
      }
    },

    async finish() {
      finished = true;
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = undefined;
      }

      // A reply that completed before the first coalesced flush still streams
      // as a single start→stop so the transcript holds one streamed message.
      if (!started && hasDeliverableAssistantText(rawText)) {
        started = true;
        enqueueStart();
      }

      enqueueAppend();
      enqueue(async () => {
        if (state !== "streaming" || !streamTs) return;
        const clean = cleanedText();
        const remaining = clean.slice(confirmedLength);
        const blocks = imageBlocks(clean);
        const title = activeProgress?.title;
        const tasks = planTasks();
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId,
            assistantId,
            slackStream: {
              action: "stop",
              streamTs,
              ...(remaining.length > 0 ? { markdownText: remaining } : {}),
              ...(blocks ? { blocks } : {}),
              ...(title ? { planTitle: title } : {}),
              ...(tasks ? { tasks } : {}),
            },
          });
          confirmedLength = clean.length;
        } catch (err) {
          log.warn(
            { err, chatId },
            "Slack stopStream failed; falling back to durable delivery",
          );
          state = "fallback";
        }
      });

      await opChain;

      if (state === "streaming" && streamTs) {
        return { mode: "streamed", messageTs: streamTs, deliveredSegmentCount };
      }
      return { mode: "fallback" };
    },
  };
}

import type { StreamPlan } from "@vellumai/gateway-client";

import type {
  AssistantEvent,
  ToolResultEvent,
  ToolUseStartEvent,
} from "../api/index.js";
import {
  incompleteVellumLinkSuffixLength,
  stripVellumLinks,
} from "../daemon/assistant-attachments.js";
import {
  getTransportForCallback,
  sendChannelStreamOp,
} from "../messaging/providers/index.js";
import { getLogger } from "../util/logger.js";
import { needsBoundarySpace } from "../util/text-spacing.js";
import {
  hasDeliverableAssistantText,
  NO_RESPONSE_INLINE_RE,
} from "./no-response.js";
import {
  getTaskProgressDataFromToolInput,
  mergeTaskProgressData,
} from "./task-progress.js";

const log = getLogger("channel-reply-session");

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
 * - `fallback`: no stream was opened (ineligible turn, neither deliverable
 *   text nor a plan, or a failed `startStream`); finalize posts the full
 *   reply normally.
 */
export type StreamReconciliation =
  | { mode: "streamed"; messageTs: string; deliveredSegmentCount: number }
  | { mode: "fallback" };

export type ChannelReplySession = {
  observeEvent: (msg: AssistantEvent) => void;
  /**
   * Settle in-flight stream operations, finalize the stream, and report how
   * durable delivery should reconcile. Call once after processing completes.
   */
  finish: () => Promise<StreamReconciliation>;
};

/**
 * Whether a channel can carry a reply that grows while the turn runs.
 *
 * Only the channel-level half is answered here, and only by asking whether
 * the transport implements the operation: implementing it is the whole of
 * declaring it. Whether THIS conversation can carry one is the platform's
 * own rule (Slack streams into a thread, Telegram only into a private chat),
 * so it is answered by the transport's own reply to `start` and reaches this
 * module as an ordinary not-ok, which falls back exactly like a failure.
 */
export function channelCanStreamReply(replyCallbackUrl?: string): boolean {
  if (!replyCallbackUrl) {
    return false;
  }
  return getTransportForCallback(replyCallbackUrl)?.streamReply !== undefined;
}

type StreamState = "idle" | "streaming" | "fallback";

/**
 * Owns the live-content lifecycle of one growing reply: it consumes the
 * assistant token stream once, opens a streamed message (in plan display
 * mode) on the first deliverable text or progress plan, whichever comes
 * first, coalesces deltas into `appendStream` calls, advances a native plan
 * block from `task_progress` surfaces, and finalizes with `stopStream`.
 *
 * Any stream-call failure degrades gracefully: the session abandons streaming
 * (state `fallback`) and reports back so durable finalize posts the full reply
 * via the normal path. Returns `undefined` for turns that are not eligible to
 * stream.
 */
export function createChannelReplySession(params: {
  replyCallbackUrl?: string;
  chatId: string;
  /**
   * The one reader a restricted stream is shown to, when the turn names one.
   * Travels as the operation's `audience`; a channel that cannot restrict a
   * growing reply ignores it, and one that requires a named reader in a room
   * refuses the start without it.
   */
  recipientUserId?: string;
  /** The reader's org, alongside {@link recipientUserId}. */
  recipientTeamId?: string;
  /** Gap between coalesced `appendStream` calls. Defaults to {@link STREAM_COALESCE_MS}. */
  coalesceMs?: number;
  /**
   * Invoked once with the streamed message's id the moment a stream that
   * BECOMES the reply opens, so the caller can durably record it before
   * delivery finalizes: a crash mid-turn then leaves a breadcrumb, and a
   * retry reconciles against the already-visible message instead of posting
   * a duplicate reply.
   *
   * Never invoked for a preview stream. A preview leaves no message behind,
   * so there is nothing for a retry to reconcile against, and recording its
   * id would point recovery at a message that never existed: the retry would
   * try to edit it and the reply would be lost rather than posted.
   */
  onStreamOpen?: (streamTs: string) => void;
}): ChannelReplySession | undefined {
  if (
    !params.replyCallbackUrl ||
    !channelCanStreamReply(params.replyCallbackUrl)
  ) {
    return undefined;
  }
  const { chatId, recipientUserId, recipientTeamId } = params;
  const coalesceMs = params.coalesceMs ?? STREAM_COALESCE_MS;
  const replyCallbackUrl = params.replyCallbackUrl;
  // What the stream leaves behind is the channel's business; the session only
  // needs to know whether the reply is still owed once the stream ends.
  const streamIsTheReply =
    getTransportForCallback(replyCallbackUrl)?.streamPersists === true;
  // How much text one operation may carry. The channel declares it; splitting
  // stays here because this is what tracks how much the channel has actually
  // taken, and that mark may only advance once per confirmed operation.
  const maxTextChars =
    getTransportForCallback(replyCallbackUrl)?.maxStreamTextChars ??
    Number.POSITIVE_INFINITY;

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

  let activeProgress: StreamPlan | undefined;
  // Fingerprint of the plan state last delivered, so progress that
  // advances without new body text still flushes as a task-only append.
  let deliveredProgressKey: string | undefined;
  // Set once a plan-only append is rejected (a channel that requires words
  // on every operation): the session stops attempting
  // them and progress rides the next text append or `stopStream` instead,
  // so a rejecting workspace pays one failed call per turn, not one per
  // progress update.
  let taskOnlyAppendsDisabled = false;

  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let opChain: Promise<void> = Promise.resolve();

  const cleanedText = (): string =>
    stripVellumLinks(rawText).replace(NO_RESPONSE_INLINE_RE, "");

  // Text safe to hand to an append-only stream: while more deltas may
  // arrive, a trailing `[label](vellum://…)` link that is still being assembled
  // is withheld so its internal path is never emitted before the link closes
  // (and `stripVellumLinks` can remove it). Once `finished`, no delta can
  // extend the text, so the full cleaned reply is safe to emit.
  const streamableText = (): string => {
    if (finished) {
      return cleanedText();
    }
    const hold = incompleteVellumLinkSuffixLength(rawText);
    const stable = hold > 0 ? rawText.slice(0, rawText.length - hold) : rawText;
    return stripVellumLinks(stable).replace(NO_RESPONSE_INLINE_RE, "");
  };

  const progressKey = (plan: StreamPlan | undefined): string | undefined =>
    plan ? JSON.stringify(plan) : undefined;

  const enqueue = (op: () => Promise<void>): void => {
    opChain = opChain.catch(() => undefined).then(op);
  };

  const enqueueStart = (): void => {
    enqueue(async () => {
      const clean = streamableText();
      const plan = activeProgress;
      // A plan alone opens the stream; text alone does too. Neither means
      // there is nothing to show yet, so the start is left for a later flush.
      if (clean.trim().length === 0 && !plan) {
        return;
      }
      // Open on what one operation may carry; the rest drains through the
      // appends that follow, each advancing the delivered mark on its own.
      const firstChunk = clean.slice(0, maxTextChars);
      try {
        const result = await sendChannelStreamOp(replyCallbackUrl, chatId, {
          action: "start",
          text: clean,
          appended: firstChunk,
          ...(plan ? { plan } : {}),
          ...(recipientUserId
            ? {
                audience: {
                  kind: "oneReader" as const,
                  userId: recipientUserId,
                  ...(recipientTeamId ? { userOrgId: recipientTeamId } : {}),
                },
              }
            : {}),
        });
        if (result.ok && result.ts) {
          streamTs = result.ts;
          confirmedLength = firstChunk.length;
          deliveredProgressKey = progressKey(plan);
          state = "streaming";
          // The stream is already open on the channel's side, so an `onStreamOpen`
          // failure must not downgrade to fallback and repost the visible
          // reply. Losing the breadcrumb only forfeits crash-window dedup —
          // strictly better than a guaranteed duplicate post.
          try {
            if (streamIsTheReply) {
              params.onStreamOpen?.(result.ts);
            }
          } catch (err) {
            log.warn(
              { err, chatId },
              "onStreamOpen callback failed; keeping streamed state",
            );
          }
        } else {
          state = "fallback";
        }
      } catch (err) {
        log.warn({ err, chatId }, "Stream start failed; falling back");
        state = "fallback";
      }
    });
    enqueueAppend();
  };

  const enqueueAppend = (): void => {
    enqueue(async () => {
      if (state !== "streaming" || !streamTs) {
        return;
      }
      const clean = streamableText();
      const plan = activeProgress;
      const key = progressKey(plan);
      // One operation per chunk the channel will accept, and the delivered
      // mark advances only for a chunk the channel confirmed. Advancing it for
      // a whole delta the channel took in pieces would let a failure part-way
      // through re-send the part that already landed, and the reader would see
      // it twice. The plan rides along, so it advances with the text.
      while (confirmedLength < clean.length) {
        const chunk = clean.slice(
          confirmedLength,
          confirmedLength + maxTextChars,
        );
        try {
          await sendChannelStreamOp(replyCallbackUrl, chatId, {
            action: "append",
            streamId: streamTs,
            text: clean,
            appended: chunk,
            ...(plan ? { plan } : {}),
          });
          confirmedLength += chunk.length;
          deliveredProgressKey = key ?? deliveredProgressKey;
        } catch (err) {
          log.warn({ err, chatId }, "Stream append failed; deferring delta");
          return;
        }
      }
      // Progress that advances without new body text still lands live:
      // `chat.appendStream` accepts a chunks-only call, so the plan block
      // ticks during tool work instead of waiting for the next text append.
      // A failure disables further task-only appends for the session; the
      // unchanged fingerprint leaves the update pending, so it rides the
      // next text append and `stopStream` carries the final state.
      if (!taskOnlyAppendsDisabled && plan && key !== deliveredProgressKey) {
        try {
          await sendChannelStreamOp(replyCallbackUrl, chatId, {
            action: "append",
            streamId: streamTs,
            text: clean,
            plan,
          });
          deliveredProgressKey = key;
        } catch (err) {
          taskOnlyAppendsDisabled = true;
          log.warn(
            { err, chatId },
            "Plan-only append failed; deferring progress to text appends",
          );
        }
      }
    });
  };

  /**
   * Whether there is anything worth opening the stream for.
   *
   * A plan counts on its own. `chat.startStream` takes `markdown_text` as
   * optional and fixes `task_display_mode` at start, so a plan-only start is
   * both legal and the only way task cards can tick while the turn works: the
   * model is told to show its progress card early on a multi-step turn, which
   * is precisely the moment it has produced no prose. Requiring text first
   * would hold every such plan back until the final answer, by which point
   * the steps it was meant to narrate are already done.
   */
  const hasOpenableContent = (): boolean =>
    hasDeliverableAssistantText(streamableText()) ||
    activeProgress !== undefined;

  const flush = (): void => {
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = undefined;
    }
    if (finished || state === "fallback") {
      return;
    }
    if (!started) {
      if (!hasOpenableContent()) {
        return;
      }
      started = true;
      enqueueStart();
      return;
    }
    enqueueAppend();
  };

  const scheduleFlush = (): void => {
    if (coalesceTimer || finished) {
      return;
    }
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

  /**
   * The plan tool calls this turn has made, awaiting their results.
   *
   * `ui_show` and `ui_update` are tools the model reaches for, so a plan is
   * turn output and arrives on this session's own stream. The daemon also
   * publishes `ui_surface_show`, but that goes to the conversation sink, which
   * no channel consumes.
   *
   * Held rather than applied on sight, because a `tool_use_start` is an
   * intention: the surface tool rejects a stale `surface_id` or a malformed
   * payload, and showing a plan the canonical surface refused is worse than
   * showing none. An update is also merged at result time so it composes onto
   * the plan actually in effect rather than the one in effect when the call
   * began.
   *
   * `ui_show` carries no surface id in its input, since the id is minted when
   * the tool runs, so a later `ui_update` cannot be matched to the card it
   * targets. One plan per turn is tracked instead, which is what a map keyed by
   * surface id collapsed to in practice: whichever entry was touched last was
   * the one rendered.
   */
  const pendingPlanCalls = new Map<
    string,
    {
      readonly kind: "show" | "update";
      readonly input: Record<string, unknown>;
    }
  >();

  const observePlanToolStart = (msg: ToolUseStartEvent): void => {
    const kind =
      msg.toolName === "ui_show"
        ? "show"
        : msg.toolName === "ui_update"
          ? "update"
          : undefined;
    if (!kind || !msg.toolUseId) {
      return;
    }
    pendingPlanCalls.set(msg.toolUseId, { kind, input: msg.input });
  };

  const observePlanToolResult = (msg: ToolResultEvent): void => {
    if (!msg.toolUseId) {
      return;
    }
    const pending = pendingPlanCalls.get(msg.toolUseId);
    if (!pending) {
      return;
    }
    pendingPlanCalls.delete(msg.toolUseId);
    if (msg.isError === true) {
      return;
    }
    const progress =
      pending.kind === "show"
        ? getTaskProgressDataFromToolInput(pending.input)
        : mergeTaskProgressData(activeProgress, pending.input.data);
    if (!progress) {
      return;
    }
    activeProgress = progress;
    scheduleFlush();
  };

  return {
    observeEvent(msg) {
      if (finished) {
        return;
      }

      if (msg.type === "tool_use_start") {
        observePlanToolStart(msg);
      }
      // guard:allow-tool-result-only. This reads `AssistantEvent`, not the
      // provider content blocks the guard protects: `web_search_tool_result`
      // is a block type in conversation history and never an event, so no
      // result can be dropped by omitting it.
      if (msg.type === "tool_result") {
        observePlanToolResult(msg);
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
      // A turn whose only output was a plan opens here too, so work the model
      // narrated only as steps still leaves the user something to read.
      // `finished` is already set, so the shared check reads the full text.
      if (!started && hasOpenableContent()) {
        started = true;
        enqueueStart();
      }

      enqueueAppend();
      enqueue(async () => {
        if (state !== "streaming" || !streamTs) {
          return;
        }
        const clean = cleanedText();
        const remaining = clean.slice(confirmedLength);
        const plan = activeProgress;
        try {
          await sendChannelStreamOp(replyCallbackUrl, chatId, {
            action: "stop",
            streamId: streamTs,
            // The whole reply, not the remainder. A channel that finalizes its
            // stream in place appends `appended`; one whose preview evaporates
            // needs this to send the message that stays.
            text: clean,
            ...(remaining.length > 0 ? { appended: remaining } : {}),
            ...(plan ? { plan } : {}),
          });
          confirmedLength = clean.length;
        } catch (err) {
          log.warn(
            { err, chatId },
            "Stream stop failed; falling back to durable delivery",
          );
          state = "fallback";
        }
      });

      await opChain;

      // A preview stream reports `fallback`: the draft evaporates, so the
      // reply is still owed and durable delivery sends it as it always would.
      if (state === "streaming" && streamTs && streamIsTheReply) {
        return { mode: "streamed", messageTs: streamTs, deliveredSegmentCount };
      }
      return { mode: "fallback" };
    },
  };
}

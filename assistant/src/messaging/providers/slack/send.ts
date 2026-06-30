/**
 * Slack outbound message orchestration.
 *
 * Handles text + Block Kit delivery, message updates, approval prompts,
 * typing indicators, reactions, thread status, ephemeral messages, and
 * attachments by calling the Slack Web API directly via ./api.ts.
 */

import type { Button, KnownBlock } from "@slack/types";
import type {
  ApprovalUIMetadata,
  SlackStreamOp,
} from "@vellumai/gateway-client";

import { getAttachmentContent } from "../../../persistence/attachments-store.js";
import type { RuntimeAttachmentMetadata } from "../../../runtime/http-types.js";
import { getLogger } from "../../../util/logger.js";
import {
  appendSlackStream,
  callSlackApi,
  callSlackApiForm,
  completeSlackUpload,
  SlackApiError,
  startSlackStream,
  stopSlackStream,
  uploadToSlackUrl,
} from "./api.js";
import { renderSlackBlocks } from "./render.js";

const log = getLogger("slack-send");

// Slack's max attachment upload size is ~1 GB, but practical limit is lower.
// Use a generous 100 MB cap for outbound attachments.
const SLACK_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Slack errors meaning the Block Kit payload is too big for one message:
 * `invalid_blocks` (malformed blocks, or over the 50-block limit) and
 * `msg_blocks_too_long` (cumulative block text over Slack's ~13k, undocumented,
 * content-dependent ceiling). The remedy is identical — resend the same message
 * without `blocks` so the text body is still delivered — which keeps Slack the
 * authority on its own limits instead of pre-guessing a byte ceiling here. Other
 * client errors (e.g. `msg_too_long`, where the text itself is too long) are
 * deliberately excluded: dropping `blocks` wouldn't help, so retrying is waste.
 */
const SLACK_OVERSIZED_BLOCKS_ERRORS = new Set([
  "invalid_blocks",
  "msg_blocks_too_long",
]);

// ---------------------------------------------------------------------------
// Approval Block Kit builder
// ---------------------------------------------------------------------------

function buildApprovalBlocks(
  message: string,
  approval: ApprovalUIMetadata,
): KnownBlock[] {
  const buttons: Button[] = approval.actions.map((action) => ({
    type: "button",
    text: { type: "plain_text", text: action.label, emoji: true },
    action_id: `apr:${approval.requestId}:${action.id}`,
    value: `apr:${approval.requestId}:${action.id}`,
  }));
  return [
    { type: "section", text: { type: "mrkdwn", text: message } },
    { type: "actions", elements: buttons },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "You can also react with :thumbsup: to approve or :thumbsdown: to deny",
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Text → Block Kit
// ---------------------------------------------------------------------------

function resolveBlocks(
  text: string | undefined,
  providedBlocks: KnownBlock[] | undefined,
  approval: ApprovalUIMetadata | undefined,
  useBlocks: boolean | undefined,
): KnownBlock[] {
  if (Array.isArray(providedBlocks) && providedBlocks.length > 0) {
    return providedBlocks;
  }
  if (approval) {
    return buildApprovalBlocks(text || approval.plainTextFallback, approval);
  }
  if (useBlocks && text) {
    return renderSlackBlocks(text) ?? [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------

async function uploadFileToSlack(
  channelId: string,
  buffer: Buffer,
  filename: string,
  threadTs?: string,
): Promise<void> {
  const urlData = await callSlackApiForm(
    "files.getUploadURLExternal",
    new URLSearchParams({ filename, length: String(buffer.length) }),
  );

  if (!urlData.upload_url || !urlData.file_id) {
    throw new Error(
      "files.getUploadURLExternal returned no upload_url/file_id",
    );
  }

  await uploadToSlackUrl(urlData.upload_url, buffer);
  await completeSlackUpload(urlData.file_id, filename, channelId, threadTs);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SlackSendOptions {
  threadTs?: string;
  blocks?: KnownBlock[];
  approval?: ApprovalUIMetadata;
  useBlocks?: boolean;
  ephemeral?: boolean;
  user?: string;
  messageTs?: string;
}

export interface SlackSendResult {
  ok: boolean;
  ts?: string;
}

/**
 * Call a Slack message API once, retrying a single time without Block Kit
 * blocks if Slack rejects the payload as too big (see
 * `SLACK_OVERSIZED_BLOCKS_ERRORS`).
 *
 * Those errors fault the Block Kit payload, not the target — the retry repeats
 * the *same* operation (same `chat.update` ts, same `chat.postMessage` thread)
 * without blocks, so it edits/posts in place rather than spawning a second
 * message. Any other error propagates to the caller.
 */
async function sendWithBlockFallback(
  method: string,
  baseBody: Record<string, unknown>,
  blocks: KnownBlock[],
  options: { fallbackWithoutBlocks: boolean },
): Promise<SlackSendResult> {
  try {
    const result = await callSlackApi(
      method,
      blocks.length > 0 ? { ...baseBody, blocks } : baseBody,
    );
    return { ok: true, ts: result.ts };
  } catch (err) {
    if (
      options.fallbackWithoutBlocks &&
      blocks.length > 0 &&
      err instanceof SlackApiError &&
      err.slackError !== undefined &&
      SLACK_OVERSIZED_BLOCKS_ERRORS.has(err.slackError)
    ) {
      log.warn(
        { method, slackError: err.slackError },
        "Slack rejected blocks; retrying without blocks",
      );
      const result = await callSlackApi(method, baseBody);
      return { ok: true, ts: result.ts };
    }
    throw err;
  }
}

/**
 * Send a Slack text message with optional Block Kit formatting.
 *
 * When `messageTs` is set this is strictly an in-place edit (`chat.update`),
 * mirroring `editMessage()` in ./withdraw.ts: a failed edit throws and is
 * never converted into a fresh `chat.postMessage`. Posting on failure would
 * leave the original message beside a duplicate ("ghost") reply; re-delivery
 * after a transient failure is the delivery layer's responsibility, not this
 * function's.
 */
export async function sendSlackReply(
  chatId: string,
  text: string,
  options?: SlackSendOptions,
): Promise<SlackSendResult> {
  const blocks = resolveBlocks(
    text,
    options?.blocks,
    options?.approval,
    options?.useBlocks,
  );

  const messageTs = options?.messageTs;
  if (typeof messageTs === "string" && messageTs.length > 0) {
    const result = await sendWithBlockFallback(
      "chat.update",
      { channel: chatId, text, ts: messageTs },
      blocks,
      { fallbackWithoutBlocks: true },
    );
    log.info({ chatId, messageTs }, "Slack message updated");
    return result;
  }

  const postBase: Record<string, unknown> = { channel: chatId, text };
  if (options?.threadTs) postBase.thread_ts = options.threadTs;

  if (options?.ephemeral) {
    if (!options.user)
      throw new Error("user is required for ephemeral messages");
    return sendWithBlockFallback(
      "chat.postEphemeral",
      { ...postBase, user: options.user },
      blocks,
      { fallbackWithoutBlocks: !options.approval },
    );
  }

  // Approval prompts carry their action buttons in `blocks`; dropping them when
  // Slack rejects the payload would post a card with no way to respond, so only
  // non-approval posts fall back to a block-free retry.
  const result = await sendWithBlockFallback(
    "chat.postMessage",
    postBase,
    blocks,
    {
      fallbackWithoutBlocks: !options?.approval,
    },
  );
  log.info({ chatId, hasThreadTs: !!options?.threadTs }, "Slack message sent");
  return result;
}

/**
 * Execute one Slack streaming operation against a channel, returning the
 * stream `ts` so the caller can carry it across `append`/`stop` calls. `start`
 * mints a new `ts`; `append` and `stop` echo the one they were given.
 *
 * Throwing on failure is intentional: the streaming session decides whether to
 * abandon the stream and let durable delivery post the full reply.
 */
export async function sendSlackStreamOp(
  channel: string,
  op: SlackStreamOp,
): Promise<SlackSendResult> {
  switch (op.action) {
    case "start": {
      const ts = await startSlackStream({
        channel,
        threadTs: op.threadTs,
        markdownText: op.markdownText,
        taskDisplayMode: op.taskDisplayMode,
        tasks: op.tasks,
      });
      log.info({ channel, ts }, "Slack stream started");
      return { ok: ts !== undefined, ts };
    }
    case "append": {
      await appendSlackStream({
        channel,
        streamTs: op.streamTs,
        markdownText: op.markdownText,
        tasks: op.tasks,
      });
      return { ok: true, ts: op.streamTs };
    }
    case "stop": {
      await stopSlackStream({
        channel,
        streamTs: op.streamTs,
        markdownText: op.markdownText,
        blocks: op.blocks,
        tasks: op.tasks,
      });
      log.info({ channel, ts: op.streamTs }, "Slack stream stopped");
      return { ok: true, ts: op.streamTs };
    }
  }
}

/**
 * Send a typing indicator placeholder message to Slack.
 * Returns the placeholder message ts for later update.
 */
export async function sendSlackTypingIndicator(
  chatId: string,
  threadTs?: string,
): Promise<string | undefined> {
  const body: Record<string, string> = { channel: chatId, text: "\u2026" };
  if (threadTs) body.thread_ts = threadTs;

  const result = await callSlackApi("chat.postMessage", body);
  log.debug(
    { chatId, placeholderTs: result.ts, hasThreadTs: !!threadTs },
    "Slack typing placeholder sent",
  );
  return result.ts;
}

/**
 * Add or remove an emoji reaction on a Slack message.
 * Non-throwing: logs errors but returns silently.
 */
export async function sendSlackReaction(
  channel: string,
  name: string,
  messageTs: string,
  action: "add" | "remove",
): Promise<void> {
  const method = action === "add" ? "reactions.add" : "reactions.remove";
  try {
    await callSlackApi(method, { channel, name, timestamp: messageTs });
  } catch (err) {
    if (err instanceof SlackApiError) {
      if (
        err.slackError === "already_reacted" ||
        err.slackError === "no_reaction"
      ) {
        return;
      }
    }
    log.warn(
      { err, channel, method, name },
      "Failed to deliver Slack reaction",
    );
  }
}

/**
 * Set or clear the Slack Assistants API thread status indicator.
 * Falls back to emoji reactions for installs without `assistant:write` scope.
 */
export async function sendSlackAssistantThreadStatus(
  channel: string,
  threadTs: string,
  status: string,
  loadingMessages?: string[],
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      channel_id: channel,
      thread_ts: threadTs,
      status,
    };
    if (loadingMessages !== undefined) {
      body.loading_messages = loadingMessages;
    }

    await callSlackApi("assistant.threads.setStatus", body);
    return;
  } catch {
    log.warn(
      { channel },
      "Slack assistant.threads.setStatus failed, falling back to reaction",
    );
  }

  const isSet = status.length > 0;
  await sendSlackReaction(channel, "eyes", threadTs, isSet ? "add" : "remove");
}

export type SlackAttachmentResult = {
  allFailed: boolean;
  failureCount: number;
  totalCount: number;
};

/**
 * Send file attachments to a Slack channel using the files.uploadV2 flow.
 */
export async function sendSlackAttachments(
  channelId: string,
  attachments: RuntimeAttachmentMetadata[],
  threadTs?: string,
): Promise<SlackAttachmentResult> {
  const failures: string[] = [];

  for (const meta of attachments) {
    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes > SLACK_MAX_ATTACHMENT_BYTES
    ) {
      log.warn(
        { attachmentId: meta.id, sizeBytes: meta.sizeBytes },
        "Skipping oversized outbound attachment",
      );
      failures.push(meta.filename ?? meta.id);
      continue;
    }

    try {
      const content = getAttachmentContent(meta.id);
      if (!content) {
        log.error(
          { attachmentId: meta.id },
          "Attachment content not found in store",
        );
        failures.push(meta.filename ?? meta.id);
        continue;
      }

      const filename = meta.filename ?? meta.id;
      const buffer = Buffer.from(new Uint8Array(content));

      if (buffer.length > SLACK_MAX_ATTACHMENT_BYTES) {
        log.warn(
          { attachmentId: meta.id, sizeBytes: buffer.length },
          "Skipping oversized outbound attachment (detected after read)",
        );
        failures.push(filename);
        continue;
      }

      await uploadFileToSlack(channelId, buffer, filename, threadTs);

      log.debug(
        { channelId, attachmentId: meta.id, filename },
        "Attachment sent to Slack",
      );
    } catch (err) {
      const displayName = meta.filename ?? meta.id;
      log.error(
        { err, attachmentId: meta.id, filename: displayName },
        "Failed to send attachment to Slack",
      );
      failures.push(displayName);
    }
  }

  if (failures.length > 0) {
    const notice = `${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
    try {
      await sendSlackReply(
        channelId,
        notice,
        threadTs ? { threadTs } : undefined,
      );
    } catch (err) {
      log.error({ err, channelId }, "Failed to send attachment failure notice");
    }
  }

  return {
    allFailed: failures.length === attachments.length,
    failureCount: failures.length,
    totalCount: attachments.length,
  };
}

/**
 * Slack outbound message orchestration.
 *
 * Handles text + Block Kit delivery, message updates, approval prompts,
 * typing indicators, reactions, thread status, ephemeral messages, and
 * attachments by calling the Slack Web API directly via ./api.ts.
 */

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";

import * as attachmentsStore from "../../../memory/attachments-store.js";
import type { RuntimeAttachmentMetadata } from "../../../runtime/http-types.js";
import { textToSlackBlocks } from "../../../runtime/slack-block-formatting.js";
import { getLogger } from "../../../util/logger.js";
import {
  callSlackApi,
  callSlackApiForm,
  completeSlackUpload,
  SlackApiError,
  uploadToSlackUrl,
} from "./api.js";

const log = getLogger("slack-send");

// Slack's max attachment upload size is ~1 GB, but practical limit is lower.
// Use a generous 100 MB cap for outbound attachments.
const SLACK_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Approval Block Kit builder (mirrors gateway/src/slack/block-kit-builder.ts)
// ---------------------------------------------------------------------------

function buildApprovalBlocks(
  message: string,
  approval: ApprovalUIMetadata,
): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: message } },
    {
      type: "actions",
      elements: approval.actions.map((action) => ({
        type: "button",
        text: { type: "plain_text", text: action.label, emoji: true },
        action_id: `apr:${approval.requestId}:${action.id}`,
        value: `apr:${approval.requestId}:${action.id}`,
      })),
    },
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
  providedBlocks: unknown[] | undefined,
  approval: ApprovalUIMetadata | undefined,
  useBlocks: boolean | undefined,
): unknown[] {
  if (Array.isArray(providedBlocks) && providedBlocks.length > 0) {
    return providedBlocks;
  }
  if (approval) {
    return buildApprovalBlocks(text || approval.plainTextFallback, approval);
  }
  if (useBlocks && text) {
    return textToSlackBlocks(text) ?? [];
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
  blocks?: unknown[];
  approval?: ApprovalUIMetadata;
  useBlocks?: boolean;
  ephemeral?: boolean;
  user?: string;
  messageTs?: string;
}

export interface SlackSendResult {
  ok: boolean;
  ts?: string;
  placeholderTs?: string;
}

/**
 * Send a Slack text message with optional Block Kit formatting.
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

  const slackBody: Record<string, unknown> = {
    channel: chatId,
    text,
  };
  if (blocks.length > 0) slackBody.blocks = blocks;
  if (options?.threadTs) slackBody.thread_ts = options.threadTs;

  const isUpdate =
    typeof options?.messageTs === "string" && options.messageTs.length > 0;

  if (isUpdate) {
    const updateBody: Record<string, unknown> = {
      channel: chatId,
      text,
      ts: options!.messageTs,
    };
    if (blocks.length > 0) updateBody.blocks = blocks;

    try {
      const result = await callSlackApi("chat.update", updateBody);
      log.info(
        { chatId, messageTs: options!.messageTs },
        "Slack message updated",
      );
      return { ok: true, ts: result.ts };
    } catch (err) {
      if (err instanceof SlackApiError && err.slackError === "invalid_blocks") {
        log.warn(
          { chatId, messageTs: options!.messageTs },
          "chat.update returned invalid_blocks; falling back to chat.postMessage without blocks",
        );
        delete slackBody.blocks;
      } else {
        log.warn(
          { chatId, messageTs: options!.messageTs },
          "Slack chat.update failed, falling back to chat.postMessage",
        );
      }
    }
  }

  if (options?.ephemeral) {
    if (!options.user)
      throw new Error("user is required for ephemeral messages");
    const result = await callSlackApi("chat.postEphemeral", {
      ...slackBody,
      user: options.user,
    });
    return { ok: true, ts: result.ts };
  }

  try {
    const result = await callSlackApi("chat.postMessage", slackBody);
    log.info(
      { chatId, hasThreadTs: !!options?.threadTs },
      "Slack message sent",
    );
    return { ok: true, ts: result.ts };
  } catch (err) {
    // Retry without blocks for invalid_blocks errors
    if (
      err instanceof SlackApiError &&
      err.slackError === "invalid_blocks" &&
      !options?.approval &&
      !options?.ephemeral &&
      Array.isArray(slackBody.blocks) &&
      (slackBody.blocks as unknown[]).length > 0
    ) {
      log.warn(
        { chatId },
        "Retrying Slack delivery without blocks after invalid_blocks",
      );
      delete slackBody.blocks;
      const result = await callSlackApi("chat.postMessage", slackBody);
      return { ok: true, ts: result.ts };
    }
    throw err;
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
): Promise<void> {
  try {
    await callSlackApi("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
    });
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
      const content = attachmentsStore.getAttachmentContent(meta.id);
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
      await sendSlackReply(channelId, notice);
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

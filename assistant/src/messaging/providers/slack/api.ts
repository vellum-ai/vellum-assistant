/**
 * Slack Web API feature surface for streaming replies, uploads, and channel
 * metadata.
 *
 * Transport (retries, envelope checking, the unified `SlackApiError`) lives in
 * `web-api-transport.ts`; identity selection lives in `auth.ts`
 * (`resolveSlackAuth`). Each call here names the identity it acts as, per the
 * rules in `auth.ts`:
 *   - "bot" for everything the assistant does as itself: streaming replies,
 *     uploads, reading its own message blocks for edit-in-place.
 *   - "user" only as a bounded FALLBACK: `conversations.info` channel-name
 *     resolution acts as the bot first and retries with the stored user token
 *     only when the bot cannot see the channel. See
 *     {@link getSlackConversationInfo} for why that stays within the
 *     neutral-bot rule for route-reachable calls.
 */

import type { KnownBlock } from "@slack/types";
import type { SlackStreamTask } from "@vellumai/gateway-client";

import { resolveSlackAuth, type SlackAuthIdentity } from "./auth.js";
import { conversationInfo } from "./client.js";
import type {
  SlackApiResponse,
  SlackConversationInfoResponse,
} from "./types.js";
import {
  SlackApiError,
  slackRequest,
  type SlackRequestOptions,
} from "./web-api-transport.js";

/** Envelope fields the outbound surfaces read off successful responses. */
interface SlackOutboundApiResponse extends SlackApiResponse {
  ts?: string;
  upload_url?: string;
  file_id?: string;
}

export interface SlackConversationInfo {
  id: string;
  name?: string;
  nameNormalized?: string;
}

/**
 * Resolve the named identity and dispatch through the shared transport.
 * Throws when no Slack credentials are configured at all; `resolveSlackAuth`
 * itself falls back user -> bot -> legacy OAuth connection before that.
 */
async function slackApiRequest<T extends SlackApiResponse>(
  identity: SlackAuthIdentity,
  method: string,
  opts: SlackRequestOptions,
): Promise<T> {
  const auth = await resolveSlackAuth(identity);
  if (!auth) {
    throw new Error("Slack bot token not configured");
  }
  return slackRequest<T>(auth, method, opts);
}

/**
 * Call a Slack Web API write method as the bot, with rate-limit retries.
 *
 * Throws SlackApiError for non-retryable Slack-level errors and for
 * transport-level failures after exhausting retries.
 */
export async function callSlackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<SlackOutboundApiResponse> {
  return slackApiRequest<SlackOutboundApiResponse>("bot", method, { body });
}

/**
 * Call a Slack Web API method as the bot with a form-urlencoded body.
 */
export async function callSlackApiForm(
  method: string,
  params: URLSearchParams,
): Promise<SlackOutboundApiResponse> {
  return slackApiRequest<SlackOutboundApiResponse>("bot", method, {
    form: params,
  });
}

// ---------------------------------------------------------------------------
// Streaming (chat.startStream / chat.appendStream / chat.stopStream)
// ---------------------------------------------------------------------------

/** Slack caps `markdown_text` at 12,000 characters per stream call. */
export const SLACK_STREAM_MARKDOWN_LIMIT = 12_000;

/** Slack caps `task_update` / `plan_update` chunk string fields at 256 characters. */
const SLACK_STREAM_CHUNK_FIELD_LIMIT = 256;

function capChunkField(value: string): string {
  return value.slice(0, SLACK_STREAM_CHUNK_FIELD_LIMIT);
}

/**
 * Build the `chunks` array for a streaming call: an optional `plan_update`
 * titling the plan block, followed by one `task_update` per task card
 * (identical in shape to the Slack task card block).
 *
 * @see https://docs.slack.dev/reference/methods/chat.appendStream/
 */
function toStreamChunks(params: {
  tasks?: readonly SlackStreamTask[];
  planTitle?: string;
}): Record<string, unknown>[] | undefined {
  const chunks: Record<string, unknown>[] = [];
  if (params.planTitle) {
    chunks.push({
      type: "plan_update",
      title: capChunkField(params.planTitle),
    });
  }
  for (const task of params.tasks ?? []) {
    chunks.push({
      type: "task_update",
      id: task.id,
      title: capChunkField(task.title),
      status: task.status,
      ...(task.details ? { details: capChunkField(task.details) } : {}),
      ...(task.output ? { output: capChunkField(task.output) } : {}),
    });
  }
  return chunks.length > 0 ? chunks : undefined;
}

/**
 * Open a streamed reply on a thread, returning its `ts` for subsequent
 * appends. `task_display_mode: "plan"` renders task chunks as a native plan.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream/
 */
export async function startSlackStream(params: {
  channel: string;
  threadTs: string;
  markdownText?: string;
  taskDisplayMode?: "plan";
  planTitle?: string;
  tasks?: readonly SlackStreamTask[];
  recipientUserId?: string;
  recipientTeamId?: string;
}): Promise<string | undefined> {
  const body: Record<string, unknown> = {
    channel: params.channel,
    thread_ts: params.threadTs,
  };
  if (params.markdownText) {
    body.markdown_text = params.markdownText;
  }
  if (params.taskDisplayMode) {
    body.task_display_mode = params.taskDisplayMode;
  }
  // Channel streams must name the reader; DMs infer it and omit both fields.
  if (params.recipientUserId) {
    body.recipient_user_id = params.recipientUserId;
  }
  if (params.recipientTeamId) {
    body.recipient_team_id = params.recipientTeamId;
  }
  const chunks = toStreamChunks(params);
  if (chunks) {
    body.chunks = chunks;
  }

  const data = await callSlackApi("chat.startStream", body);
  return data.ts;
}

/**
 * Append markdown and/or task chunks to an open stream. Slack accepts an append
 * carrying either `markdown_text` or `chunks`, so a task-only append advances
 * the plan block without new body text.
 *
 * @see https://docs.slack.dev/reference/methods/chat.appendStream/
 */
export async function appendSlackStream(params: {
  channel: string;
  streamTs: string;
  markdownText?: string;
  planTitle?: string;
  tasks?: readonly SlackStreamTask[];
}): Promise<void> {
  const body: Record<string, unknown> = {
    channel: params.channel,
    ts: params.streamTs,
  };
  if (params.markdownText) {
    body.markdown_text = params.markdownText;
  }
  const chunks = toStreamChunks(params);
  if (chunks) {
    body.chunks = chunks;
  }

  await callSlackApi("chat.appendStream", body);
}

/**
 * Finalize a stream, optionally rendering rich Block Kit blocks at the bottom
 * of the message. Blocks are accepted only here, not on append.
 *
 * @see https://docs.slack.dev/reference/methods/chat.stopStream/
 */
export async function stopSlackStream(params: {
  channel: string;
  streamTs: string;
  markdownText?: string;
  blocks?: readonly KnownBlock[];
  planTitle?: string;
  tasks?: readonly SlackStreamTask[];
}): Promise<void> {
  const body: Record<string, unknown> = {
    channel: params.channel,
    ts: params.streamTs,
  };
  if (params.markdownText) {
    body.markdown_text = params.markdownText;
  }
  if (params.blocks && params.blocks.length > 0) {
    body.blocks = params.blocks;
  }
  const chunks = toStreamChunks(params);
  if (chunks) {
    body.chunks = chunks;
  }

  await callSlackApi("chat.stopStream", body);
}

function normalizeSlackString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseSlackConversationInfo(
  data: SlackConversationInfoResponse,
): SlackConversationInfo | null {
  const id = normalizeSlackString(data.channel?.id);
  if (!id) {
    return null;
  }

  const name = normalizeSlackString(data.channel?.name);
  const nameNormalized = normalizeSlackString(data.channel?.name_normalized);

  return {
    id,
    ...(name ? { name } : {}),
    ...(nameNormalized ? { nameNormalized } : {}),
  };
}

/**
 * Resolve a channel's identity and display names via `conversations.info`.
 *
 * Acts as the bot first, honoring the neutral-bot rule for route-reachable
 * calls (`auth.ts`): this function backs the `slack_channel_name_resolve`
 * route. When the bot cannot see the channel (`channel_not_found` /
 * permission errors) and a DISTINCT user token is stored, it retries once as
 * the owner, so channels the owner is in but the bot is not still resolve.
 * The wider identity is used only for the exact case the bot cannot answer,
 * and the response is scoped to a channel the calling conversation is
 * already bound to. Legacy OAuth installs have no separate user identity, so
 * the fallback never fires there.
 */
export async function getSlackConversationInfo(
  channelId: string,
): Promise<SlackConversationInfo | null> {
  const botAuth = await resolveSlackAuth("bot");
  if (!botAuth) {
    throw new Error("Slack bot token not configured");
  }

  try {
    return parseSlackConversationInfo(
      await conversationInfo(botAuth, channelId),
    );
  } catch (err) {
    if (
      !(err instanceof SlackApiError) ||
      (err.category !== "channel_not_found" && err.category !== "permission")
    ) {
      throw err;
    }
    const userAuth = await resolveSlackAuth("user");
    if (
      typeof botAuth !== "string" ||
      typeof userAuth !== "string" ||
      userAuth === botAuth
    ) {
      throw err;
    }
    return parseSlackConversationInfo(
      await conversationInfo(userAuth, channelId),
    );
  }
}

interface SlackHistoryResponse extends SlackApiResponse {
  messages?: Array<{ ts?: string; blocks?: unknown[] }>;
}

/**
 * Fetch the Block Kit blocks of a single channel message by timestamp.
 *
 * Used to edit a message in place while preserving its existing content, e.g.
 * withdrawing an approval card's buttons without discarding the card body.
 * Acts as the bot: the messages being edited are the bot's own. Returns null
 * when the message can't be read (missing `*:history` scope, a threaded reply
 * not present in channel history, or a deleted message) so callers can degrade
 * gracefully instead of failing the edit.
 */
export async function getSlackMessageBlocks(
  channelId: string,
  ts: string,
): Promise<unknown[] | null> {
  const data = await slackApiRequest<SlackHistoryResponse>(
    "bot",
    "conversations.history",
    {
      query: {
        channel: channelId,
        latest: ts,
        oldest: ts,
        inclusive: "true",
        limit: "1",
      },
    },
  );
  const message = data.messages?.find((m) => m.ts === ts) ?? data.messages?.[0];
  return Array.isArray(message?.blocks) ? message.blocks : null;
}

/**
 * Upload raw bytes to a Slack-provided upload URL.
 */
export async function uploadToSlackUrl(
  uploadUrl: string,
  buffer: Buffer,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(buffer),
  });
  if (!response.ok) {
    throw new Error(
      `File upload to Slack failed with status ${response.status}`,
    );
  }
}

/**
 * Complete a file upload and share it to a channel.
 */
export async function completeSlackUpload(
  fileId: string,
  filename: string,
  channelId: string,
  threadTs?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    files: [{ id: fileId, title: filename }],
    channel_id: channelId,
  };
  if (threadTs) {
    body.thread_ts = threadTs;
  }
  await callSlackApi("files.completeUploadExternal", body);
}

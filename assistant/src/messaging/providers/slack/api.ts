/**
 * Slack Web API client for direct outbound messaging.
 *
 * Calls the Slack Web API directly using bot_token from the secure store,
 * eliminating the gateway HTTP proxy hop. Rate-limit retries, error
 * classification, and payload shapes follow Slack Web API conventions.
 */

import type { KnownBlock } from "@slack/types";
import type { SlackStreamTask } from "@vellumai/gateway-client";

import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("slack-api");

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_MAX_RATE_LIMIT_RETRIES = 3;
const SLACK_DEFAULT_RETRY_AFTER_S = 1;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type SlackErrorCategory =
  | "auth"
  | "rate_limit"
  | "not_found"
  | "permission"
  | "channel_not_found"
  | "client_error"
  | "transient"
  | "unknown";

const SLACK_ERROR_CODE_MAP: Record<string, SlackErrorCategory> = {
  invalid_auth: "auth",
  token_expired: "auth",
  token_revoked: "auth",
  not_authed: "auth",
  account_inactive: "auth",
  org_login_required: "auth",
  rate_limited: "rate_limit",
  ratelimited: "rate_limit",
  channel_not_found: "channel_not_found",
  is_archived: "channel_not_found",
  not_in_channel: "permission",
  missing_scope: "permission",
  ekm_access_denied: "permission",
  not_allowed_token_type: "permission",
  restricted_action: "permission",
  cannot_dm_bot: "permission",
  user_not_found: "not_found",
  message_not_found: "not_found",
  thread_not_found: "not_found",
  invalid_blocks: "client_error",
};

function classifySlackError(errorCode: string | undefined): SlackErrorCategory {
  if (!errorCode) return "unknown";
  return SLACK_ERROR_CODE_MAP[errorCode] ?? "unknown";
}

export class SlackApiError extends Error {
  readonly slackError: string | undefined;
  readonly category: SlackErrorCategory;

  constructor(slackError: string | undefined) {
    super(`Slack API error: ${slackError ?? "unknown"}`);
    this.name = "SlackApiError";
    this.slackError = slackError;
    this.category = classifySlackError(slackError);
  }
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

async function resolveBotToken(): Promise<string> {
  const botToken = await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  if (!botToken) {
    throw new Error("Slack bot token not configured");
  }
  return botToken;
}

// ---------------------------------------------------------------------------
// Core API caller with rate-limit retries
// ---------------------------------------------------------------------------

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  upload_url?: string;
  file_id?: string;
}

interface SlackConversationsInfoResponse extends SlackApiResponse {
  channel?: {
    id?: unknown;
    name?: unknown;
    name_normalized?: unknown;
  };
}

export interface SlackConversationInfo {
  id: string;
  name?: string;
  nameNormalized?: string;
}

/**
 * Call a Slack Web API method with rate-limit retries.
 *
 * Throws SlackApiError for non-retryable Slack-level errors.
 * Throws Error for transport-level failures after exhausting retries.
 */
export async function callSlackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<SlackApiResponse> {
  const botToken = await resolveBotToken();

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= SLACK_MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      if (attempt >= SLACK_MAX_RATE_LIMIT_RETRIES) {
        throw new Error("Slack rate limit exceeded after retries");
      }
      const retryAfter =
        parseInt(response.headers.get("Retry-After") ?? "", 10) ||
        SLACK_DEFAULT_RETRY_AFTER_S;
      log.warn({ method, retryAfter, attempt }, "Slack rate limited, retrying");
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (response.status >= 500) {
      if (attempt >= SLACK_MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `Slack ${method} failed with status ${response.status} after retries`,
        );
      }
      log.warn(
        { method, status: response.status, attempt },
        "Slack 5xx error, retrying",
      );
      await new Promise((r) =>
        setTimeout(r, SLACK_DEFAULT_RETRY_AFTER_S * 1000),
      );
      continue;
    }

    const data = (await response.json()) as SlackApiResponse;

    if (!data.ok) {
      lastError = data.error;
      const category = classifySlackError(data.error);

      if (category === "rate_limit" && attempt < SLACK_MAX_RATE_LIMIT_RETRIES) {
        log.warn(
          { method, slackError: data.error, attempt },
          "Slack rate limited (body), retrying",
        );
        await new Promise((r) =>
          setTimeout(r, SLACK_DEFAULT_RETRY_AFTER_S * 1000),
        );
        continue;
      }

      throw new SlackApiError(data.error);
    }

    return data;
  }

  throw new Error(
    `Slack ${method} failed after retries: ${lastError ?? "unknown"}`,
  );
}

/**
 * Call a Slack Web API read method with query parameters.
 */
async function callSlackApiGet(
  method: string,
  params: URLSearchParams,
): Promise<SlackApiResponse> {
  const botToken = await resolveBotToken();
  const query = params.toString();
  const url = `${SLACK_API_BASE}/${method}${query ? `?${query}` : ""}`;

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= SLACK_MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });

    if (response.status === 429) {
      if (attempt >= SLACK_MAX_RATE_LIMIT_RETRIES) {
        throw new Error("Slack rate limit exceeded after retries");
      }
      const retryAfter =
        parseInt(response.headers.get("Retry-After") ?? "", 10) ||
        SLACK_DEFAULT_RETRY_AFTER_S;
      log.warn({ method, retryAfter, attempt }, "Slack rate limited, retrying");
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (response.status >= 500) {
      if (attempt >= SLACK_MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `Slack ${method} failed with status ${response.status} after retries`,
        );
      }
      log.warn(
        { method, status: response.status, attempt },
        "Slack 5xx error, retrying",
      );
      await new Promise((r) =>
        setTimeout(r, SLACK_DEFAULT_RETRY_AFTER_S * 1000),
      );
      continue;
    }

    const data = (await response.json()) as SlackApiResponse;

    if (!data.ok) {
      lastError = data.error;
      const category = classifySlackError(data.error);

      if (category === "rate_limit" && attempt < SLACK_MAX_RATE_LIMIT_RETRIES) {
        log.warn(
          { method, slackError: data.error, attempt },
          "Slack rate limited (body), retrying",
        );
        await new Promise((r) =>
          setTimeout(r, SLACK_DEFAULT_RETRY_AFTER_S * 1000),
        );
        continue;
      }

      throw new SlackApiError(data.error);
    }

    return data;
  }

  throw new Error(
    `Slack ${method} failed after retries: ${lastError ?? "unknown"}`,
  );
}

// ---------------------------------------------------------------------------
// Streaming (chat.startStream / chat.appendStream / chat.stopStream)
// ---------------------------------------------------------------------------

/** Slack caps `markdown_text` at 12,000 characters per stream call. */
export const SLACK_STREAM_MARKDOWN_LIMIT = 12_000;

/**
 * A `task_update` streaming chunk. Identical in shape to the Slack task card
 * block, used to render plan progress while a stream is open.
 *
 * @see https://docs.slack.dev/reference/methods/chat.appendStream/
 */
function toTaskUpdateChunks(
  tasks: readonly SlackStreamTask[] | undefined,
): Record<string, unknown>[] | undefined {
  if (!tasks || tasks.length === 0) return undefined;
  return tasks.map((task) => ({
    type: "task_update",
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.details ? { details: task.details } : {}),
    ...(task.output ? { output: task.output } : {}),
  }));
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
  tasks?: readonly SlackStreamTask[];
  recipientUserId?: string;
  recipientTeamId?: string;
}): Promise<string | undefined> {
  const body: Record<string, unknown> = {
    channel: params.channel,
    thread_ts: params.threadTs,
  };
  if (params.markdownText) body.markdown_text = params.markdownText;
  if (params.taskDisplayMode) body.task_display_mode = params.taskDisplayMode;
  // Channel streams must name the reader; DMs infer it and omit both fields.
  if (params.recipientUserId) body.recipient_user_id = params.recipientUserId;
  if (params.recipientTeamId) body.recipient_team_id = params.recipientTeamId;
  const chunks = toTaskUpdateChunks(params.tasks);
  if (chunks) body.chunks = chunks;

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
  tasks?: readonly SlackStreamTask[];
}): Promise<void> {
  const body: Record<string, unknown> = {
    channel: params.channel,
    ts: params.streamTs,
  };
  if (params.markdownText) body.markdown_text = params.markdownText;
  const chunks = toTaskUpdateChunks(params.tasks);
  if (chunks) body.chunks = chunks;

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
  tasks?: readonly SlackStreamTask[];
}): Promise<void> {
  const body: Record<string, unknown> = {
    channel: params.channel,
    ts: params.streamTs,
  };
  if (params.markdownText) body.markdown_text = params.markdownText;
  if (params.blocks && params.blocks.length > 0) body.blocks = params.blocks;
  const chunks = toTaskUpdateChunks(params.tasks);
  if (chunks) body.chunks = chunks;

  await callSlackApi("chat.stopStream", body);
}

function normalizeSlackString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function getSlackConversationInfo(
  channelId: string,
): Promise<SlackConversationInfo | null> {
  const data = (await callSlackApiGet(
    "conversations.info",
    new URLSearchParams({ channel: channelId }),
  )) as SlackConversationsInfoResponse;

  const id = normalizeSlackString(data.channel?.id);
  if (!id) return null;

  const name = normalizeSlackString(data.channel?.name);
  const nameNormalized = normalizeSlackString(data.channel?.name_normalized);

  return {
    id,
    ...(name ? { name } : {}),
    ...(nameNormalized ? { nameNormalized } : {}),
  };
}

interface SlackHistoryResponse extends SlackApiResponse {
  messages?: Array<{ ts?: string; blocks?: unknown[] }>;
}

/**
 * Fetch the Block Kit blocks of a single channel message by timestamp.
 *
 * Used to edit a message in place while preserving its existing content — e.g.
 * withdrawing an approval card's buttons without discarding the card body.
 * Returns null when the message can't be read (missing `*:history` scope, a
 * threaded reply not present in channel history, or a deleted message) so
 * callers can degrade gracefully instead of failing the edit.
 */
export async function getSlackMessageBlocks(
  channelId: string,
  ts: string,
): Promise<unknown[] | null> {
  const data = (await callSlackApiGet(
    "conversations.history",
    new URLSearchParams({
      channel: channelId,
      latest: ts,
      oldest: ts,
      inclusive: "true",
      limit: "1",
    }),
  )) as SlackHistoryResponse;
  const message = data.messages?.find((m) => m.ts === ts) ?? data.messages?.[0];
  return Array.isArray(message?.blocks) ? message.blocks : null;
}

/**
 * Call a Slack Web API method with form-urlencoded body.
 */
export async function callSlackApiForm(
  method: string,
  params: URLSearchParams,
): Promise<SlackApiResponse> {
  const botToken = await resolveBotToken();

  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const data = (await response.json()) as SlackApiResponse;
  if (!data.ok) {
    throw new SlackApiError(data.error);
  }
  return data;
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

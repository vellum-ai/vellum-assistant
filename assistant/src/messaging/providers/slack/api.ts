/**
 * Slack Web API client for direct outbound messaging.
 *
 * Calls the Slack Web API directly using bot_token from the secure store,
 * eliminating the gateway HTTP proxy hop. Rate-limit retries, error
 * classification, and payload shapes follow Slack Web API conventions.
 */

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

function classifySlackError(
  errorCode: string | undefined,
): SlackErrorCategory {
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

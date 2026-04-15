/**
 * Low-level Slack Web API wrapper.
 *
 * All methods accept either an OAuthConnection or a raw token string.
 * Throws SlackApiError on failures, with status: 401 on auth errors
 * for withValidToken compatibility.
 *
 * String overloads are retained for non-OAuth callers (e.g. slack/share.ts)
 * that pass raw bot tokens via resolveSlackToken(). These bypass the
 * OAuthConnection model by design.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
import type {
  SlackApiResponse,
  SlackAuthTestResponse,
  SlackChatDeleteResponse,
  SlackChatUpdateResponse,
  SlackConversationHistoryResponse,
  SlackConversationInfoResponse,
  SlackConversationJoinResponse,
  SlackConversationLeaveResponse,
  SlackConversationMarkResponse,
  SlackConversationRepliesResponse,
  SlackConversationsListResponse,
  SlackConversationsOpenResponse,
  SlackPostEphemeralResponse,
  SlackPostMessageResponse,
  SlackReactionAddResponse,
  SlackSearchMessagesResponse,
  SlackUserInfoResponse,
} from "./types.js";

const SLACK_API_BASE = "https://slack.com/api";
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 1;

export class SlackApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly slackError: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

/**
 * Sleep helper that respects Slack's Retry-After header value.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check a Slack API response envelope for errors and map to SlackApiError.
 * Returns the data if ok, throws otherwise.
 */
function checkSlackEnvelope<T extends SlackApiResponse>(data: T): T {
  if (!data.ok) {
    const slackError = data.error ?? "unknown_error";
    const status = [
      "invalid_auth",
      "token_expired",
      "token_revoked",
      "not_authed",
    ].includes(slackError)
      ? 401
      : 400;
    throw new SlackApiError(
      status,
      slackError,
      `Slack API error: ${slackError}`,
    );
  }
  return data;
}

/**
 * Build a Slack API request using a raw token (for retry via `connection.withToken`).
 */
async function rawSlackRequest<T extends SlackApiResponse>(
  token: string,
  method: string,
  query: Record<string, string> | undefined,
  body: Record<string, unknown> | undefined,
): Promise<T> {
  let url = `${SLACK_API_BASE}/${method}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let init: RequestInit;
  if (body) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    init = { method: "POST", headers, body: JSON.stringify(body) };
  } else {
    if (query && Object.keys(query).length > 0) {
      url += `?${new URLSearchParams(query)}`;
    }
    init = { method: "GET", headers };
  }

  const resp = await fetch(url, init);
  if (resp.status === 429) {
    throw new SlackApiError(429, "rate_limited", "Slack API rate limited");
  }
  if (!resp.ok) {
    throw new SlackApiError(
      resp.status,
      `http_${resp.status}`,
      `Slack API HTTP ${resp.status}`,
    );
  }
  return checkSlackEnvelope((await resp.json()) as T);
}

/**
 * Execute a Slack API request via OAuthConnection with rate-limit retry.
 *
 * Slack returns HTTP 200 with `{ ok: false, error: "invalid_auth" }` for
 * auth errors. Because `connection.request()` delegates to `withValidToken`
 * which only retries on HTTP-level 401s, we catch Slack envelope auth
 * errors (mapped to SlackApiError with status 401) and perform a single
 * retry via `connection.withToken()` which forces a token refresh before
 * giving us the new token.
 */
async function requestViaConnection<T extends SlackApiResponse>(
  connection: OAuthConnection,
  method: string,
  params?: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): Promise<T> {
  const query: Record<string, string> | undefined = params
    ? Object.fromEntries(
        Object.entries(params).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : undefined;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await connection.request({
      method: body ? "POST" : "GET",
      path: `/${method}`,
      query: query && Object.keys(query).length > 0 ? query : undefined,
      body,
    });

    // Handle 429 rate limits with Retry-After backoff
    if (resp.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new SlackApiError(429, "rate_limited", "Slack API rate limited");
      }
      const retryAfter =
        parseInt(
          resp.headers["retry-after"] ?? resp.headers["Retry-After"] ?? "",
          10,
        ) || DEFAULT_RETRY_AFTER_S;
      await sleepMs(retryAfter * 1000);
      continue;
    }

    if (resp.status >= 400) {
      throw new SlackApiError(
        resp.status,
        `http_${resp.status}`,
        `Slack API HTTP ${resp.status}`,
      );
    }

    const data = resp.body as T;

    // Handle rate_limited error in response body (some Slack APIs return 200 with error)
    if (
      !data.ok &&
      data.error === "rate_limited" &&
      attempt < MAX_RATE_LIMIT_RETRIES
    ) {
      await sleepMs(DEFAULT_RETRY_AFTER_S * 1000);
      continue;
    }

    try {
      return checkSlackEnvelope(data);
    } catch (err) {
      // Slack envelope auth errors (invalid_auth, token_expired, etc.) come
      // back as HTTP 200, so they escape withValidToken's retry scope inside
      // connection.request(). Catch them here and retry once with a freshly-
      // refreshed token via connection.withToken().
      if (err instanceof SlackApiError && err.status === 401) {
        return connection.withToken((freshToken) =>
          rawSlackRequest<T>(freshToken, method, query, body),
        );
      }
      throw err;
    }
  }

  // Unreachable, but TypeScript needs this
  throw new SlackApiError(429, "rate_limited", "Slack API rate limited");
}

/**
 * Execute a Slack API request via raw token with rate-limit retry.
 */
async function requestViaToken<T extends SlackApiResponse>(
  token: string,
  method: string,
  params?: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): Promise<T> {
  let url = `${SLACK_API_BASE}/${method}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let init: RequestInit;
  if (body) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    init = { method: "POST", headers, body: JSON.stringify(body) };
  } else {
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) searchParams.set(k, v);
      }
      url += `?${searchParams}`;
    }
    init = { method: "GET", headers };
  }

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(url, init);

    // Handle 429 rate limits with Retry-After backoff
    if (resp.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new SlackApiError(429, "rate_limited", "Slack API rate limited");
      }
      const retryAfter =
        parseInt(resp.headers.get("Retry-After") ?? "", 10) ||
        DEFAULT_RETRY_AFTER_S;
      await sleepMs(retryAfter * 1000);
      continue;
    }

    if (!resp.ok) {
      throw new SlackApiError(
        resp.status,
        `http_${resp.status}`,
        `Slack API HTTP ${resp.status}`,
      );
    }

    const data = (await resp.json()) as T;

    // Handle rate_limited error in response body (some Slack APIs return 200 with error)
    if (
      !data.ok &&
      data.error === "rate_limited" &&
      attempt < MAX_RATE_LIMIT_RETRIES
    ) {
      await sleepMs(DEFAULT_RETRY_AFTER_S * 1000);
      continue;
    }

    return checkSlackEnvelope(data);
  }

  // Unreachable, but TypeScript needs this
  throw new SlackApiError(429, "rate_limited", "Slack API rate limited");
}

async function request<T extends SlackApiResponse>(
  connectionOrToken: OAuthConnection | string,
  method: string,
  params?: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): Promise<T> {
  if (typeof connectionOrToken === "string") {
    return requestViaToken<T>(connectionOrToken, method, params, body);
  }
  return requestViaConnection<T>(connectionOrToken, method, params, body);
}

export async function authTest(
  connectionOrToken: OAuthConnection | string,
): Promise<SlackAuthTestResponse> {
  return request<SlackAuthTestResponse>(connectionOrToken, "auth.test");
}

export async function listConversations(
  connectionOrToken: OAuthConnection | string,
  types = "public_channel,private_channel,mpim,im",
  excludeArchived = true,
  limit = 200,
  cursor?: string,
): Promise<SlackConversationsListResponse> {
  return request<SlackConversationsListResponse>(
    connectionOrToken,
    "conversations.list",
    {
      types,
      exclude_archived: String(excludeArchived),
      limit: String(limit),
      cursor,
    },
  );
}

export async function conversationInfo(
  connectionOrToken: OAuthConnection | string,
  channel: string,
): Promise<SlackConversationInfoResponse> {
  return request<SlackConversationInfoResponse>(
    connectionOrToken,
    "conversations.info",
    {
      channel,
    },
  );
}

export async function conversationHistory(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  limit = 50,
  latest?: string,
  oldest?: string,
  cursor?: string,
): Promise<SlackConversationHistoryResponse> {
  return request<SlackConversationHistoryResponse>(
    connectionOrToken,
    "conversations.history",
    {
      channel,
      limit: String(limit),
      latest,
      oldest,
      cursor,
    },
  );
}

export async function conversationReplies(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  ts: string,
  limit = 50,
): Promise<SlackConversationRepliesResponse> {
  return request<SlackConversationRepliesResponse>(
    connectionOrToken,
    "conversations.replies",
    {
      channel,
      ts,
      limit: String(limit),
    },
  );
}

export async function conversationMark(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  ts: string,
): Promise<SlackConversationMarkResponse> {
  return request<SlackConversationMarkResponse>(
    connectionOrToken,
    "conversations.mark",
    undefined,
    {
      channel,
      ts,
    },
  );
}

export async function conversationsOpen(
  connectionOrToken: OAuthConnection | string,
  userId: string,
): Promise<SlackConversationsOpenResponse> {
  return request<SlackConversationsOpenResponse>(
    connectionOrToken,
    "conversations.open",
    undefined,
    {
      users: userId,
    },
  );
}

export async function userInfo(
  connectionOrToken: OAuthConnection | string,
  userId: string,
): Promise<SlackUserInfoResponse> {
  return request<SlackUserInfoResponse>(connectionOrToken, "users.info", {
    user: userId,
  });
}

export interface PostMessageOptions {
  threadTs?: string;
  blocks?: unknown[];
}

export async function postMessage(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  text: string,
  optionsOrThreadTs?: PostMessageOptions | string,
): Promise<SlackPostMessageResponse> {
  const opts: PostMessageOptions =
    typeof optionsOrThreadTs === "string"
      ? { threadTs: optionsOrThreadTs }
      : (optionsOrThreadTs ?? {});
  const body: Record<string, unknown> = { channel, text };
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  if (opts.blocks) body.blocks = opts.blocks;
  return request<SlackPostMessageResponse>(
    connectionOrToken,
    "chat.postMessage",
    undefined,
    body,
  );
}

/**
 * Post an ephemeral message visible only to the specified user.
 *
 * Ephemeral messages are fire-and-forget: they cannot be edited or deleted
 * after posting, and they disappear when the user reloads the Slack client.
 */
export async function postEphemeral(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
): Promise<SlackPostEphemeralResponse> {
  const body: Record<string, unknown> = { channel, user, text };
  if (threadTs) body.thread_ts = threadTs;
  return request<SlackPostEphemeralResponse>(
    connectionOrToken,
    "chat.postEphemeral",
    undefined,
    body,
  );
}

export async function searchMessages(
  connectionOrToken: OAuthConnection | string,
  query: string,
  count = 20,
  page = 1,
): Promise<SlackSearchMessagesResponse> {
  return request<SlackSearchMessagesResponse>(
    connectionOrToken,
    "search.messages",
    {
      query,
      count: String(count),
      page: String(page),
    },
  );
}

export async function addReaction(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  timestamp: string,
  name: string,
): Promise<SlackReactionAddResponse> {
  return request<SlackReactionAddResponse>(
    connectionOrToken,
    "reactions.add",
    undefined,
    {
      channel,
      timestamp,
      name,
    },
  );
}

export async function updateMessage(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  ts: string,
  text: string,
): Promise<SlackChatUpdateResponse> {
  return request<SlackChatUpdateResponse>(
    connectionOrToken,
    "chat.update",
    undefined,
    {
      channel,
      ts,
      text,
    },
  );
}

export async function deleteMessage(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  ts: string,
): Promise<SlackChatDeleteResponse> {
  return request<SlackChatDeleteResponse>(
    connectionOrToken,
    "chat.delete",
    undefined,
    {
      channel,
      ts,
    },
  );
}

export async function joinConversation(
  connectionOrToken: OAuthConnection | string,
  channel: string,
): Promise<SlackConversationJoinResponse> {
  return request<SlackConversationJoinResponse>(
    connectionOrToken,
    "conversations.join",
    undefined,
    {
      channel,
    },
  );
}

export async function leaveConversation(
  connectionOrToken: OAuthConnection | string,
  channel: string,
): Promise<SlackConversationLeaveResponse> {
  return request<SlackConversationLeaveResponse>(
    connectionOrToken,
    "conversations.leave",
    undefined,
    {
      channel,
    },
  );
}


/**
 * Low-level Slack Web API wrapper.
 *
 * All methods take a user OAuth token and throw SlackApiError on failures.
 * Throws with status: 401 on auth errors for withValidToken compatibility.
 */

import type {
  SlackApiResponse,
  SlackAuthTestResponse,
  SlackChatDeleteResponse,
  SlackChatUpdateResponse,
  SlackConversationHistoryResponse,
  SlackConversationInfoResponse,
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

async function request<T extends SlackApiResponse>(
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
    if (!data.ok) {
      const slackError = data.error ?? "unknown_error";

      // Handle rate_limited error in response body (some Slack APIs return 200 with error)
      if (slackError === "rate_limited" && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleepMs(DEFAULT_RETRY_AFTER_S * 1000);
        continue;
      }

      // Map auth errors to 401 for token-manager retry
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

  // Unreachable, but TypeScript needs this
  throw new SlackApiError(429, "rate_limited", "Slack API rate limited");
}

export async function authTest(token: string): Promise<SlackAuthTestResponse> {
  return request<SlackAuthTestResponse>(token, "auth.test");
}

export async function listConversations(
  token: string,
  types = "public_channel,private_channel,mpim,im",
  excludeArchived = true,
  limit = 200,
  cursor?: string,
): Promise<SlackConversationsListResponse> {
  return request<SlackConversationsListResponse>(token, "conversations.list", {
    types,
    exclude_archived: String(excludeArchived),
    limit: String(limit),
    cursor,
  });
}

export async function conversationInfo(
  token: string,
  channel: string,
): Promise<SlackConversationInfoResponse> {
  return request<SlackConversationInfoResponse>(token, "conversations.info", {
    channel,
  });
}

export async function conversationHistory(
  token: string,
  channel: string,
  limit = 50,
  latest?: string,
  oldest?: string,
  cursor?: string,
): Promise<SlackConversationHistoryResponse> {
  return request<SlackConversationHistoryResponse>(
    token,
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
  token: string,
  channel: string,
  ts: string,
  limit = 50,
): Promise<SlackConversationRepliesResponse> {
  return request<SlackConversationRepliesResponse>(
    token,
    "conversations.replies",
    {
      channel,
      ts,
      limit: String(limit),
    },
  );
}

export async function conversationMark(
  token: string,
  channel: string,
  ts: string,
): Promise<SlackConversationMarkResponse> {
  return request<SlackConversationMarkResponse>(
    token,
    "conversations.mark",
    undefined,
    {
      channel,
      ts,
    },
  );
}

export async function conversationsOpen(
  token: string,
  userId: string,
): Promise<SlackConversationsOpenResponse> {
  return request<SlackConversationsOpenResponse>(
    token,
    "conversations.open",
    undefined,
    {
      users: userId,
    },
  );
}

export async function userInfo(
  token: string,
  userId: string,
): Promise<SlackUserInfoResponse> {
  return request<SlackUserInfoResponse>(token, "users.info", { user: userId });
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<SlackPostMessageResponse> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  return request<SlackPostMessageResponse>(
    token,
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
  token: string,
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
): Promise<SlackPostEphemeralResponse> {
  const body: Record<string, unknown> = { channel, user, text };
  if (threadTs) body.thread_ts = threadTs;
  return request<SlackPostEphemeralResponse>(
    token,
    "chat.postEphemeral",
    undefined,
    body,
  );
}

export async function searchMessages(
  token: string,
  query: string,
  count = 20,
  page = 1,
): Promise<SlackSearchMessagesResponse> {
  return request<SlackSearchMessagesResponse>(token, "search.messages", {
    query,
    count: String(count),
    page: String(page),
  });
}

export async function addReaction(
  token: string,
  channel: string,
  timestamp: string,
  name: string,
): Promise<SlackReactionAddResponse> {
  return request<SlackReactionAddResponse>(token, "reactions.add", undefined, {
    channel,
    timestamp,
    name,
  });
}

export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
): Promise<SlackChatUpdateResponse> {
  return request<SlackChatUpdateResponse>(token, "chat.update", undefined, {
    channel,
    ts,
    text,
  });
}

export async function deleteMessage(
  token: string,
  channel: string,
  ts: string,
): Promise<SlackChatDeleteResponse> {
  return request<SlackChatDeleteResponse>(token, "chat.delete", undefined, {
    channel,
    ts,
  });
}

export async function leaveConversation(
  token: string,
  channel: string,
): Promise<SlackConversationLeaveResponse> {
  return request<SlackConversationLeaveResponse>(
    token,
    "conversations.leave",
    undefined,
    {
      channel,
    },
  );
}

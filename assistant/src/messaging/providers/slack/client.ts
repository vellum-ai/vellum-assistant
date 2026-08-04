/**
 * Typed Slack Web API method wrappers.
 *
 * All methods accept either an OAuthConnection or a raw token string.
 * Transport (retries, envelope checking, the unified `SlackApiError`) lives
 * in `web-api-transport.ts`.
 *
 * String overloads are retained for non-OAuth callers (e.g. slack/share.ts)
 * that pass raw bot tokens via resolveSlackToken(). These bypass the
 * OAuthConnection model by design.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
import type {
  SlackApiResponse,
  SlackAuthTestResponse,
  SlackBotsInfoResponse,
  SlackConversationHistoryResponse,
  SlackConversationInfoResponse,
  SlackConversationMarkResponse,
  SlackConversationRepliesResponse,
  SlackConversationsListResponse,
  SlackConversationsOpenResponse,
  SlackPostMessageResponse,
  SlackReactionsAddResponse,
  SlackSearchMessagesResponse,
  SlackUserInfoResponse,
  SlackUsersListResponse,
} from "./types.js";
import { slackRequest } from "./web-api-transport.js";

async function request<T extends SlackApiResponse>(
  connectionOrToken: OAuthConnection | string,
  method: string,
  params?: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): Promise<T> {
  return slackRequest<T>(connectionOrToken, method, {
    ...(params ? { query: params } : {}),
    ...(body ? { body } : {}),
  });
}

export async function authTest(
  connectionOrToken: OAuthConnection | string,
): Promise<SlackAuthTestResponse> {
  return request<SlackAuthTestResponse>(connectionOrToken, "auth.test");
}

export async function botsInfo(
  connectionOrToken: OAuthConnection | string,
  botId: string,
  teamId?: string,
): Promise<SlackBotsInfoResponse> {
  return request<SlackBotsInfoResponse>(connectionOrToken, "bots.info", {
    bot: botId,
    team_id: teamId,
  });
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

export async function conversationHistory(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  limit = 50,
  latest?: string,
  oldest?: string,
  cursor?: string,
  inclusive?: boolean,
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
      inclusive: inclusive === undefined ? undefined : String(inclusive),
    },
  );
}

export async function conversationReplies(
  connectionOrToken: OAuthConnection | string,
  channel: string,
  ts: string,
  limit = 50,
  latest?: string,
  oldest?: string,
  inclusive?: boolean,
  cursor?: string,
): Promise<SlackConversationRepliesResponse> {
  return request<SlackConversationRepliesResponse>(
    connectionOrToken,
    "conversations.replies",
    {
      channel,
      ts,
      limit: String(limit),
      latest,
      oldest,
      inclusive: inclusive === undefined ? undefined : String(inclusive),
      cursor,
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

export async function conversationInfo(
  connectionOrToken: OAuthConnection | string,
  channel: string,
): Promise<SlackConversationInfoResponse> {
  return request<SlackConversationInfoResponse>(
    connectionOrToken,
    "conversations.info",
    { channel },
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
  if (opts.threadTs) {
    body.thread_ts = opts.threadTs;
  }
  if (opts.blocks) {
    body.blocks = opts.blocks;
  }
  return request<SlackPostMessageResponse>(
    connectionOrToken,
    "chat.postMessage",
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
): Promise<SlackReactionsAddResponse> {
  return request<SlackReactionsAddResponse>(
    connectionOrToken,
    "reactions.add",
    undefined,
    { channel, timestamp, name },
  );
}

export async function listUsers(
  connectionOrToken: OAuthConnection | string,
  limit = 200,
  cursor?: string,
): Promise<SlackUsersListResponse> {
  return request<SlackUsersListResponse>(connectionOrToken, "users.list", {
    limit: String(limit),
    cursor,
  });
}

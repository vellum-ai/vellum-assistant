/**
 * Low-level Slack Web API wrapper.
 *
 * All methods take a user OAuth token and throw SlackApiError on failures.
 * Throws with status: 401 on auth errors for withValidToken compatibility.
 */

import type {
  SlackAuthTestResponse,
  SlackConversationsListResponse,
  SlackConversationHistoryResponse,
  SlackConversationRepliesResponse,
  SlackUserInfoResponse,
  SlackPostMessageResponse,
  SlackSearchMessagesResponse,
  SlackReactionAddResponse,
  SlackConversationLeaveResponse,
  SlackConversationMarkResponse,
  SlackApiResponse,
} from './types.js';

const SLACK_API_BASE = 'https://slack.com/api';

export class SlackApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly slackError: string,
    message: string,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
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
    headers['Content-Type'] = 'application/json; charset=utf-8';
    init = { method: 'POST', headers, body: JSON.stringify(body) };
  } else {
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) searchParams.set(k, v);
      }
      url += `?${searchParams}`;
    }
    init = { method: 'GET', headers };
  }

  const resp = await fetch(url, init);
  if (!resp.ok) {
    throw new SlackApiError(resp.status, `http_${resp.status}`, `Slack API HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as T;
  if (!data.ok) {
    const slackError = data.error ?? 'unknown_error';
    // Map auth errors to 401 for token-manager retry
    const status = ['invalid_auth', 'token_expired', 'token_revoked', 'not_authed'].includes(slackError) ? 401 : 400;
    throw new SlackApiError(status, slackError, `Slack API error: ${slackError}`);
  }

  return data;
}

export async function authTest(token: string): Promise<SlackAuthTestResponse> {
  return request<SlackAuthTestResponse>(token, 'auth.test');
}

export async function listConversations(
  token: string,
  types = 'public_channel,private_channel,mpim,im',
  excludeArchived = true,
  limit = 200,
  cursor?: string,
): Promise<SlackConversationsListResponse> {
  return request<SlackConversationsListResponse>(token, 'conversations.list', {
    types,
    exclude_archived: String(excludeArchived),
    limit: String(limit),
    cursor,
  });
}

export async function conversationHistory(
  token: string,
  channel: string,
  limit = 50,
  latest?: string,
  oldest?: string,
): Promise<SlackConversationHistoryResponse> {
  return request<SlackConversationHistoryResponse>(token, 'conversations.history', {
    channel,
    limit: String(limit),
    latest,
    oldest,
  });
}

export async function conversationReplies(
  token: string,
  channel: string,
  ts: string,
  limit = 50,
): Promise<SlackConversationRepliesResponse> {
  return request<SlackConversationRepliesResponse>(token, 'conversations.replies', {
    channel,
    ts,
    limit: String(limit),
  });
}

export async function conversationMark(
  token: string,
  channel: string,
  ts: string,
): Promise<SlackConversationMarkResponse> {
  return request<SlackConversationMarkResponse>(token, 'conversations.mark', undefined, {
    channel,
    ts,
  });
}

export async function userInfo(
  token: string,
  userId: string,
): Promise<SlackUserInfoResponse> {
  return request<SlackUserInfoResponse>(token, 'users.info', { user: userId });
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<SlackPostMessageResponse> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  return request<SlackPostMessageResponse>(token, 'chat.postMessage', undefined, body);
}

export async function searchMessages(
  token: string,
  query: string,
  count = 20,
  page = 1,
): Promise<SlackSearchMessagesResponse> {
  return request<SlackSearchMessagesResponse>(token, 'search.messages', {
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
  return request<SlackReactionAddResponse>(token, 'reactions.add', undefined, {
    channel,
    timestamp,
    name,
  });
}

export async function leaveConversation(
  token: string,
  channel: string,
): Promise<SlackConversationLeaveResponse> {
  return request<SlackConversationLeaveResponse>(token, 'conversations.leave', undefined, {
    channel,
  });
}

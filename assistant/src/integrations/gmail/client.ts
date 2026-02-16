import type {
  GmailMessage,
  GmailMessageListResponse,
  GmailLabel,
  GmailLabelsListResponse,
  GmailProfile,
  GmailDraft,
  GmailModifyRequest,
  GmailMessageFormat,
} from './types.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Max concurrent requests for batch operations */
const BATCH_CONCURRENCY = 5;

export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

async function request<T>(token: string, path: string, options?: RequestInit): Promise<T> {
  const url = `${GMAIL_API_BASE}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new GmailApiError(resp.status, resp.statusText, `Gmail API ${resp.status}: ${body}`);
  }
  return resp.json() as Promise<T>;
}

/** List messages matching a query. */
export async function listMessages(
  token: string,
  query?: string,
  maxResults = 20,
  pageToken?: string,
  labelIds?: string[],
): Promise<GmailMessageListResponse> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('maxResults', String(maxResults));
  if (pageToken) params.set('pageToken', pageToken);
  if (labelIds) {
    for (const id of labelIds) params.append('labelIds', id);
  }
  return request<GmailMessageListResponse>(token, `/messages?${params}`);
}

/** Get a single message by ID. */
export async function getMessage(
  token: string,
  messageId: string,
  format: GmailMessageFormat = 'full',
  metadataHeaders?: string[],
): Promise<GmailMessage> {
  const params = new URLSearchParams({ format });
  if (format === 'metadata' && metadataHeaders) {
    for (const h of metadataHeaders) params.append('metadataHeaders', h);
  }
  return request<GmailMessage>(token, `/messages/${messageId}?${params}`);
}

/** Get multiple messages in parallel with capped concurrency. */
export async function batchGetMessages(
  token: string,
  messageIds: string[],
  format: GmailMessageFormat = 'full',
  metadataHeaders?: string[],
): Promise<GmailMessage[]> {
  const results: GmailMessage[] = [];
  for (let i = 0; i < messageIds.length; i += BATCH_CONCURRENCY) {
    const batch = messageIds.slice(i, i + BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((id) => getMessage(token, id, format, metadataHeaders)),
    );
    results.push(...batchResults);
  }
  return results;
}

/** Modify labels on a single message. */
export async function modifyMessage(
  token: string,
  messageId: string,
  modifications: GmailModifyRequest,
): Promise<GmailMessage> {
  return request<GmailMessage>(token, `/messages/${messageId}/modify`, {
    method: 'POST',
    body: JSON.stringify(modifications),
  });
}

/** Batch modify labels on multiple messages. */
export async function batchModifyMessages(
  token: string,
  messageIds: string[],
  modifications: GmailModifyRequest,
): Promise<void> {
  await request<void>(token, '/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({ ids: messageIds, ...modifications }),
  });
}

/** Move a message to trash. */
export async function trashMessage(
  token: string,
  messageId: string,
): Promise<GmailMessage> {
  return request<GmailMessage>(token, `/messages/${messageId}/trash`, {
    method: 'POST',
  });
}

/** List all labels. */
export async function listLabels(token: string): Promise<GmailLabel[]> {
  const resp = await request<GmailLabelsListResponse>(token, '/labels');
  return resp.labels ?? [];
}

/** Create a draft. */
export async function createDraft(
  token: string,
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
): Promise<GmailDraft> {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }
  const raw = btoa(`${headers.join('\r\n')}\r\n\r\n${body}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return request<GmailDraft>(token, '/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw } }),
  });
}

/** Send an email. */
export async function sendMessage(
  token: string,
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
): Promise<GmailMessage> {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }
  const raw = btoa(`${headers.join('\r\n')}\r\n\r\n${body}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return request<GmailMessage>(token, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  });
}

/** Get the authenticated user's profile (email address). */
export async function getProfile(token: string): Promise<GmailProfile> {
  return request<GmailProfile>(token, '/profile');
}

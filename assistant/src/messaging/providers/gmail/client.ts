import type {
  GmailAttachment,
  GmailDraft,
  GmailFilter,
  GmailFilterAction,
  GmailFilterCriteria,
  GmailFiltersListResponse,
  GmailLabel,
  GmailLabelsListResponse,
  GmailMessage,
  GmailMessageFormat,
  GmailMessageListResponse,
  GmailModifyRequest,
  GmailProfile,
  GmailVacationSettings,
} from './types.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Max concurrent requests for batch operations */
const BATCH_CONCURRENCY = 50;

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

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

function isIdempotent(options?: RequestInit): boolean {
  const method = (options?.method ?? 'GET').toUpperCase();
  return IDEMPOTENT_METHODS.has(method);
}

interface GmailRequestOptions extends RequestInit {
  /** Override method-based retry eligibility. When true, retries on 429/5xx even for POST requests. */
  retryable?: boolean;
}

async function request<T>(token: string, path: string, options?: GmailRequestOptions): Promise<T> {
  const url = `${GMAIL_API_BASE}${path}`;
  const canRetry = options?.retryable ?? isIdempotent(options);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!resp.ok) {
      if (canRetry && isRetryable(resp.status) && attempt < MAX_RETRIES) {
        const retryAfter = resp.headers.get('retry-after');
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const body = await resp.text().catch(() => '');
      throw new GmailApiError(resp.status, resp.statusText, `Gmail API ${resp.status}: ${body}`);
    }

    // Some endpoints (e.g. batchModify) return empty success responses
    const contentLength = resp.headers.get('content-length');
    if (resp.status === 204 || contentLength === '0') {
      return undefined as T;
    }
    const text = await resp.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // Unreachable — the loop always returns or throws — but TypeScript needs this
  throw new Error('Unreachable: retry loop exited without returning or throwing');
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
    retryable: true,
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
    retryable: true,
  });
}

/** Move a message to trash. */
export async function trashMessage(
  token: string,
  messageId: string,
): Promise<GmailMessage> {
  return request<GmailMessage>(token, `/messages/${messageId}/trash`, {
    method: 'POST',
    retryable: true,
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
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf-8')
    .toString('base64')
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
  threadId?: string,
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
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const payload: Record<string, unknown> = { raw };
  if (threadId) payload.threadId = threadId;
  return request<GmailMessage>(token, '/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Get the authenticated user's profile (email address). */
export async function getProfile(token: string): Promise<GmailProfile> {
  return request<GmailProfile>(token, '/profile');
}

/** Get attachment data for a message. */
export async function getAttachment(
  token: string,
  messageId: string,
  attachmentId: string,
): Promise<GmailAttachment> {
  return request<GmailAttachment>(token, `/messages/${messageId}/attachments/${attachmentId}`);
}

/** Send an email with a pre-built raw MIME payload (for multipart/attachments). */
export async function sendMessageRaw(
  token: string,
  raw: string,
  threadId?: string,
): Promise<GmailMessage> {
  const payload: Record<string, unknown> = { raw };
  if (threadId) payload.threadId = threadId;
  return request<GmailMessage>(token, '/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Create a user label. */
export async function createLabel(
  token: string,
  name: string,
  opts?: { messageListVisibility?: 'show' | 'hide'; labelListVisibility?: 'labelShow' | 'labelShowIfUnread' | 'labelHide' },
): Promise<GmailLabel> {
  return request<GmailLabel>(token, '/labels', {
    method: 'POST',
    body: JSON.stringify({ name, ...opts }),
  });
}

/** List all Gmail filters. */
export async function listFilters(token: string): Promise<GmailFilter[]> {
  const resp = await request<GmailFiltersListResponse>(token, '/settings/filters');
  return resp.filter ?? [];
}

/** Create a Gmail filter. */
export async function createFilter(
  token: string,
  criteria: GmailFilterCriteria,
  action: GmailFilterAction,
): Promise<GmailFilter> {
  return request<GmailFilter>(token, '/settings/filters', {
    method: 'POST',
    body: JSON.stringify({ criteria, action }),
  });
}

/** Delete a Gmail filter. */
export async function deleteFilter(token: string, filterId: string): Promise<void> {
  await request<void>(token, `/settings/filters/${filterId}`, { method: 'DELETE' });
}

/** Get vacation auto-reply settings. */
export async function getVacation(token: string): Promise<GmailVacationSettings> {
  return request<GmailVacationSettings>(token, '/settings/vacation');
}

/** Update vacation auto-reply settings. */
export async function updateVacation(
  token: string,
  settings: GmailVacationSettings,
): Promise<GmailVacationSettings> {
  return request<GmailVacationSettings>(token, '/settings/vacation', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

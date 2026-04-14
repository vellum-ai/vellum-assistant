import type {
  OAuthConnection,
  OAuthConnectionResponse,
} from "../../../oauth/connection.js";
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
} from "./types.js";

const GMAIL_BATCH_URL = "https://www.googleapis.com/batch/gmail/v1";

/** Max sub-requests per batch HTTP call (Gmail API limit) */
const BATCH_SUB_LIMIT = 100;
/** Max concurrent batch calls */
const BATCH_CONCURRENCY = 8;

export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
/** Timeout for batch API calls that bypass OAuthConnection.request() (which has its own 30s timeout). */
const REQUEST_TIMEOUT_MS = 30_000;

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

function isIdempotent(options?: RequestInit): boolean {
  const method = (options?.method ?? "GET").toUpperCase();
  return IDEMPOTENT_METHODS.has(method);
}

interface GmailRequestOptions extends RequestInit {
  /** Override method-based retry eligibility. When true, retries on 429/5xx even for POST requests. */
  retryable?: boolean;
}

/**
 * Extract non-Authorization headers from request options for use with OAuthConnection.
 */
function extractNonAuthHeaders(
  options?: GmailRequestOptions,
): Record<string, string> | undefined {
  if (!options?.headers) return undefined;
  const raw = options.headers;
  const result: Record<string, string> = {};
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      if (k.toLowerCase() !== "authorization") result[k] = v;
    });
  } else if (Array.isArray(raw)) {
    for (const [k, v] of raw) {
      if (k.toLowerCase() !== "authorization") result[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(raw)) {
      if (k.toLowerCase() !== "authorization" && v !== undefined) result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Convert URLSearchParams to a query record, collapsing multi-valued keys into arrays.
 */
function paramsToQuery(
  params: URLSearchParams,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

/**
 * Extract the JSON body from request options for use with OAuthConnection.
 */
function extractBody(options?: GmailRequestOptions): unknown | undefined {
  if (!options?.body) return undefined;
  if (typeof options.body === "string") {
    try {
      return JSON.parse(options.body);
    } catch {
      return options.body;
    }
  }
  return options.body;
}

async function request<T>(
  connection: OAuthConnection,
  path: string,
  options?: GmailRequestOptions,
  query?: Record<string, string | string[]>,
): Promise<T> {
  const canRetry = options?.retryable ?? isIdempotent(options);
  const method = (options?.method ?? "GET").toUpperCase();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp: OAuthConnectionResponse;
    try {
      resp = await connection.request({
        method,
        path,
        query,
        headers: {
          "Content-Type": "application/json",
          ...extractNonAuthHeaders(options),
        },
        body: extractBody(options),
      });
    } catch (err) {
      // Network-level errors from connection.request() are not retryable
      throw err;
    }

    if (resp.status < 200 || resp.status >= 300) {
      if (canRetry && isRetryable(resp.status) && attempt < MAX_RETRIES) {
        const retryAfter =
          resp.headers["retry-after"] ?? resp.headers["Retry-After"];
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const bodyStr =
        typeof resp.body === "string"
          ? resp.body
          : JSON.stringify(resp.body ?? "");
      throw new GmailApiError(
        resp.status,
        "",
        `Gmail API ${resp.status}: ${bodyStr}`,
      );
    }

    // Success — body is already parsed by connection.request()
    if (resp.status === 204 || resp.body === undefined) {
      return undefined as T;
    }
    return resp.body as T;
  }

  throw new Error(
    "Unreachable: retry loop exited without returning or throwing",
  );
}

/** List messages matching a query. */
export async function listMessages(
  connection: OAuthConnection,
  query?: string,
  maxResults = 20,
  pageToken?: string,
  labelIds?: string[],
): Promise<GmailMessageListResponse> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("maxResults", String(maxResults));
  if (pageToken) params.set("pageToken", pageToken);
  if (labelIds) {
    for (const id of labelIds) params.append("labelIds", id);
  }
  return request<GmailMessageListResponse>(
    connection,
    "/messages",
    undefined,
    paramsToQuery(params),
  );
}

/** Get a single message by ID. */
export async function getMessage(
  connection: OAuthConnection,
  messageId: string,
  format: GmailMessageFormat = "full",
  metadataHeaders?: string[],
  fields?: string,
): Promise<GmailMessage> {
  const params = new URLSearchParams({ format });
  if (format === "metadata" && metadataHeaders) {
    for (const h of metadataHeaders) params.append("metadataHeaders", h);
  }
  if (fields) params.set("fields", fields);
  return request<GmailMessage>(
    connection,
    `/messages/${messageId}`,
    undefined,
    paramsToQuery(params),
  );
}

/**
 * Parse a single part from a multipart batch response into its HTTP status and JSON body.
 * Each part contains MIME headers, then an embedded HTTP response (status line, headers, body).
 */
function parseSubResponse(
  part: string,
): { index: number; status: number; json: string | null } | null {
  const idMatch = part.match(/Content-ID:\s*<response-(\d+)>/i);
  if (!idMatch) return null;
  const index = parseInt(idMatch[1], 10);

  // Split MIME headers from the embedded HTTP response (separated by blank line)
  const mimeEnd = part.search(/\r?\n\r?\n/);
  if (mimeEnd === -1) return null;
  const httpResponse = part.slice(mimeEnd).replace(/^(\r?\n){2}/, "");

  const statusMatch = httpResponse.match(/^HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  // Split HTTP headers from body (separated by blank line)
  const bodyStart = httpResponse.search(/\r?\n\r?\n/);
  if (bodyStart === -1) return { index, status, json: null };
  const json = httpResponse
    .slice(bodyStart)
    .replace(/^(\r?\n){2}/, "")
    .trim();

  return { index, status, json: json || null };
}

/**
 * Execute a single batch HTTP call packing up to 100 getMessage sub-requests.
 * Returns successfully parsed messages and a list of IDs that failed (for individual retry).
 */
async function executeBatchCall(
  connection: OAuthConnection,
  messageIds: string[],
  format: GmailMessageFormat,
  metadataHeaders: string[] | undefined,
  fields?: string,
): Promise<{
  messages: Array<{ index: number; msg: GmailMessage }>;
  failedIds: Array<{ index: number; id: string }>;
}> {
  const boundary = `batch_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  // Build query string once (shared by all sub-requests)
  const params = new URLSearchParams({ format });
  if (format === "metadata" && metadataHeaders) {
    for (const h of metadataHeaders) params.append("metadataHeaders", h);
  }
  if (fields) params.set("fields", fields);
  const qs = params.toString();

  // Build multipart request body
  const parts = messageIds.map(
    (id, i) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${qs}\r\n`,
  );
  const body = parts.join("") + `--${boundary}--\r\n`;

  const doBatchFetch = async (token: string) => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const resp = await fetch(GMAIL_BATCH_URL, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
        },
        body,
      });

      if (!resp.ok) {
        if (isRetryable(resp.status) && attempt < MAX_RETRIES) {
          const retryAfter = resp.headers.get("retry-after");
          const delayMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        const errBody = await resp.text().catch(() => "");
        throw new GmailApiError(
          resp.status,
          resp.statusText,
          `Gmail batch API ${resp.status}: ${errBody}`,
        );
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const responseText = await resp.text();

      const boundaryMatch = contentType.match(
        /boundary=(?:"([^"]+)"|([^\s;]+))/,
      );
      const respBoundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
      if (!respBoundary)
        throw new Error("Missing boundary in Gmail batch response");

      const respParts = responseText.split(`--${respBoundary}`);
      const messages: Array<{ index: number; msg: GmailMessage }> = [];
      const failedIds: Array<{ index: number; id: string }> = [];

      for (const rp of respParts) {
        const parsed = parseSubResponse(rp);
        if (!parsed) continue;

        if (parsed.status >= 200 && parsed.status < 300 && parsed.json) {
          try {
            messages.push({
              index: parsed.index,
              msg: JSON.parse(parsed.json) as GmailMessage,
            });
          } catch {
            failedIds.push({
              index: parsed.index,
              id: messageIds[parsed.index],
            });
          }
        } else {
          failedIds.push({
            index: parsed.index,
            id: messageIds[parsed.index],
          });
        }
      }

      return { messages, failedIds };
    }

    throw new Error(
      "Unreachable: batch retry loop exited without returning or throwing",
    );
  };

  // Use withToken to get raw token for batch endpoint
  return connection.withToken(doBatchFetch);
}

/** Max concurrent individual getMessage requests (matches batch concurrency) */
const INDIVIDUAL_CONCURRENCY = BATCH_CONCURRENCY;

/**
 * Fetch all messages individually using getMessage (no batch endpoint).
 * Used as a fallback when the batch API is unavailable (e.g. platform connections
 * that cannot expose raw tokens for the multipart batch endpoint).
 *
 * Processes messages in waves of INDIVIDUAL_CONCURRENCY to avoid unbounded
 * parallelism that would trigger 429s on high-volume paths like senderDigest.
 */
async function fetchMessagesIndividually(
  connection: OAuthConnection,
  messageIds: string[],
  format: GmailMessageFormat,
  metadataHeaders?: string[],
  fields?: string,
): Promise<GmailMessage[]> {
  const results: GmailMessage[] = [];
  for (let i = 0; i < messageIds.length; i += INDIVIDUAL_CONCURRENCY) {
    const wave = messageIds.slice(i, i + INDIVIDUAL_CONCURRENCY);
    const waveResults = await Promise.all(
      wave.map((id) =>
        getMessage(connection, id, format, metadataHeaders, fields),
      ),
    );
    results.push(...waveResults);
  }
  return results;
}

/**
 * Get multiple messages using Gmail's batch HTTP endpoint.
 * Packs up to 100 sub-requests per HTTP call and runs up to BATCH_CONCURRENCY calls in parallel.
 * Falls back to individual getMessage for any sub-requests that fail within a batch.
 *
 * For connections that do not support raw token access (e.g. platform-managed connections),
 * falls back to fetching each message individually via connection.request().
 */
export async function batchGetMessages(
  connection: OAuthConnection,
  messageIds: string[],
  format: GmailMessageFormat = "full",
  metadataHeaders?: string[],
  fields?: string,
): Promise<GmailMessage[]> {
  if (messageIds.length === 0) return [];

  // Single message -- just use getMessage directly
  if (messageIds.length === 1) {
    return [
      await getMessage(
        connection,
        messageIds[0],
        format,
        metadataHeaders,
        fields,
      ),
    ];
  }

  // Try batch API first; fall back to individual fetches if withToken is unavailable
  // (e.g. platform-managed connections where raw tokens cannot be exposed).
  let useBatch = true;
  try {
    // Probe withToken availability with a no-op call
    await connection.withToken(async (token) => token);
  } catch {
    useBatch = false;
  }

  if (!useBatch) {
    return fetchMessagesIndividually(
      connection,
      messageIds,
      format,
      metadataHeaders,
      fields,
    );
  }

  const results = new Array<GmailMessage | undefined>(messageIds.length).fill(
    undefined,
  );

  // Chunk into groups of BATCH_SUB_LIMIT, then run BATCH_CONCURRENCY in parallel
  const chunks: Array<{ startIndex: number; ids: string[] }> = [];
  for (let i = 0; i < messageIds.length; i += BATCH_SUB_LIMIT) {
    chunks.push({
      startIndex: i,
      ids: messageIds.slice(i, i + BATCH_SUB_LIMIT),
    });
  }

  for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
    const wave = chunks.slice(i, i + BATCH_CONCURRENCY);
    const waveResults = await Promise.all(
      wave.map((chunk) =>
        executeBatchCall(
          connection,
          chunk.ids,
          format,
          metadataHeaders,
          fields,
        ),
      ),
    );

    // Place successful messages into the result array
    for (let w = 0; w < wave.length; w++) {
      const { messages, failedIds } = waveResults[w];
      const baseIndex = wave[w].startIndex;

      for (const { index, msg } of messages) {
        results[baseIndex + index] = msg;
      }

      // Retry failed sub-requests individually
      if (failedIds.length > 0) {
        const retried = await Promise.all(
          failedIds.map(({ id }) =>
            getMessage(connection, id, format, metadataHeaders, fields),
          ),
        );
        for (let r = 0; r < failedIds.length; r++) {
          results[baseIndex + failedIds[r].index] = retried[r];
        }
      }
    }
  }

  return results.filter((m): m is GmailMessage => m !== undefined);
}

/** Modify labels on a single message. */
export async function modifyMessage(
  connection: OAuthConnection,
  messageId: string,
  modifications: GmailModifyRequest,
): Promise<GmailMessage> {
  return request<GmailMessage>(connection, `/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify(modifications),
    retryable: true,
  });
}

/** Batch modify labels on multiple messages. */
export async function batchModifyMessages(
  connection: OAuthConnection,
  messageIds: string[],
  modifications: GmailModifyRequest,
): Promise<void> {
  await request<void>(connection, "/messages/batchModify", {
    method: "POST",
    body: JSON.stringify({ ids: messageIds, ...modifications }),
    retryable: true,
  });
}

/** Move a message to trash. */
export async function trashMessage(
  connection: OAuthConnection,
  messageId: string,
): Promise<GmailMessage> {
  return request<GmailMessage>(connection, `/messages/${messageId}/trash`, {
    method: "POST",
    retryable: true,
  });
}

/** List all labels. */
export async function listLabels(
  connection: OAuthConnection,
): Promise<GmailLabel[]> {
  const resp = await request<GmailLabelsListResponse>(connection, "/labels");
  return resp.labels ?? [];
}

/** Create a draft. */
export async function createDraft(
  connection: OAuthConnection,
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
  cc?: string,
  bcc?: string,
  threadId?: string,
): Promise<GmailDraft> {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const message: Record<string, unknown> = { raw };
  if (threadId) message.threadId = threadId;
  return request<GmailDraft>(connection, "/drafts", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Create a draft from a pre-built base64url MIME payload. */
export async function createDraftRaw(
  connection: OAuthConnection,
  raw: string,
  threadId?: string,
): Promise<GmailDraft> {
  const message: Record<string, unknown> = { raw };
  if (threadId) message.threadId = threadId;
  return request<GmailDraft>(connection, "/drafts", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Send an existing draft by ID. */
export async function sendDraft(
  connection: OAuthConnection,
  draftId: string,
): Promise<GmailMessage> {
  return request<GmailMessage>(connection, "/drafts/send", {
    method: "POST",
    body: JSON.stringify({ id: draftId }),
  });
}

/** Send an email. */
export async function sendMessage(
  connection: OAuthConnection,
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
  threadId?: string,
): Promise<GmailMessage> {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload: Record<string, unknown> = { raw };
  if (threadId) payload.threadId = threadId;
  return request<GmailMessage>(connection, "/messages/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Get the authenticated user's profile (email address). */
export async function getProfile(
  connection: OAuthConnection,
): Promise<GmailProfile> {
  return request<GmailProfile>(connection, "/profile");
}

/** Get attachment data for a message. */
export async function getAttachment(
  connection: OAuthConnection,
  messageId: string,
  attachmentId: string,
): Promise<GmailAttachment> {
  return request<GmailAttachment>(
    connection,
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
}

/** Send an email with a pre-built raw MIME payload (for multipart/attachments). */
export async function sendMessageRaw(
  connection: OAuthConnection,
  raw: string,
  threadId?: string,
): Promise<GmailMessage> {
  const payload: Record<string, unknown> = { raw };
  if (threadId) payload.threadId = threadId;
  return request<GmailMessage>(connection, "/messages/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Create a user label. */
export async function createLabel(
  connection: OAuthConnection,
  name: string,
  opts?: {
    messageListVisibility?: "show" | "hide";
    labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  },
): Promise<GmailLabel> {
  return request<GmailLabel>(connection, "/labels", {
    method: "POST",
    body: JSON.stringify({ name, ...opts }),
  });
}

/** List all Gmail filters. */
export async function listFilters(
  connection: OAuthConnection,
): Promise<GmailFilter[]> {
  const resp = await request<GmailFiltersListResponse>(
    connection,
    "/settings/filters",
  );
  return resp.filter ?? [];
}

/** Create a Gmail filter. */
export async function createFilter(
  connection: OAuthConnection,
  criteria: GmailFilterCriteria,
  action: GmailFilterAction,
): Promise<GmailFilter> {
  return request<GmailFilter>(connection, "/settings/filters", {
    method: "POST",
    body: JSON.stringify({ criteria, action }),
  });
}

/** Delete a Gmail filter. */
export async function deleteFilter(
  connection: OAuthConnection,
  filterId: string,
): Promise<void> {
  await request<void>(connection, `/settings/filters/${filterId}`, {
    method: "DELETE",
  });
}

/** Get vacation auto-reply settings. */
export async function getVacation(
  connection: OAuthConnection,
): Promise<GmailVacationSettings> {
  return request<GmailVacationSettings>(connection, "/settings/vacation");
}

/** Update vacation auto-reply settings. */
export async function updateVacation(
  connection: OAuthConnection,
  settings: GmailVacationSettings,
): Promise<GmailVacationSettings> {
  return request<GmailVacationSettings>(connection, "/settings/vacation", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

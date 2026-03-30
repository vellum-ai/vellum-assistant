import type {
  OAuthConnection,
  OAuthConnectionResponse,
} from "../../../oauth/connection.js";
import type {
  OutlookMailFolder,
  OutlookMailFolderListResponse,
  OutlookMessage,
  OutlookMessageListResponse,
  OutlookSendMessagePayload,
  OutlookUserProfile,
} from "./types.js";

export class OutlookApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "OutlookApiError";
  }
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Make an authenticated request to the Microsoft Graph API with retry logic.
 *
 * The OAuth provider's baseUrl is already configured to `https://graph.microsoft.com/v1.0/me`,
 * so paths are relative to `/me` (e.g. `/messages`, `/mailFolders`).
 */
async function request<T>(
  connection: OAuthConnection,
  path: string,
  options?: RequestInit,
  query?: Record<string, string | string[]>,
): Promise<T> {
  const method = (options?.method ?? "GET").toUpperCase();
  const canRetry = isIdempotent(method);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp: OAuthConnectionResponse;
    try {
      resp = await connection.request({
        method,
        path,
        query,
        headers: {
          "Content-Type": "application/json",
        },
        body: options?.body ? JSON.parse(options.body as string) : undefined,
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
      throw new OutlookApiError(
        resp.status,
        "",
        `Microsoft Graph API ${resp.status}: ${bodyStr}`,
      );
    }

    // Success
    if (resp.status === 204 || resp.body === undefined) {
      return undefined as T;
    }
    return resp.body as T;
  }

  throw new Error(
    "Unreachable: retry loop exited without returning or throwing",
  );
}

/** Get the authenticated user's profile. */
export async function getProfile(
  connection: OAuthConnection,
): Promise<OutlookUserProfile> {
  // The baseUrl already points to /me, so an empty path returns the user profile.
  return request<OutlookUserProfile>(connection, "");
}

/** List messages, optionally within a specific folder. */
export async function listMessages(
  connection: OAuthConnection,
  options?: {
    folderId?: string;
    top?: number;
    skip?: number;
    filter?: string;
    orderby?: string;
    select?: string;
  },
): Promise<OutlookMessageListResponse> {
  const path = options?.folderId
    ? `/mailFolders/${options.folderId}/messages`
    : "/messages";

  const query: Record<string, string> = {};
  if (options?.top !== undefined) query["$top"] = String(options.top);
  if (options?.skip !== undefined) query["$skip"] = String(options.skip);
  if (options?.filter) query["$filter"] = options.filter;
  if (options?.orderby) query["$orderby"] = options.orderby;
  if (options?.select) query["$select"] = options.select;

  return request<OutlookMessageListResponse>(
    connection,
    path,
    undefined,
    Object.keys(query).length > 0 ? query : undefined,
  );
}

/** Get a single message by ID. */
export async function getMessage(
  connection: OAuthConnection,
  messageId: string,
  select?: string,
): Promise<OutlookMessage> {
  const query: Record<string, string> = {};
  if (select) query["$select"] = select;

  return request<OutlookMessage>(
    connection,
    `/messages/${messageId}`,
    undefined,
    Object.keys(query).length > 0 ? query : undefined,
  );
}

/** Search messages using Microsoft Graph KQL syntax. */
export async function searchMessages(
  connection: OAuthConnection,
  searchQuery: string,
  options?: {
    top?: number;
    skip?: number;
  },
): Promise<OutlookMessageListResponse> {
  const query: Record<string, string> = {
    $search: `"${searchQuery}"`,
  };
  if (options?.top !== undefined) query["$top"] = String(options.top);
  if (options?.skip !== undefined) query["$skip"] = String(options.skip);

  return request<OutlookMessageListResponse>(
    connection,
    "/messages",
    undefined,
    query,
  );
}

/** Send a new message. */
export async function sendMessage(
  connection: OAuthConnection,
  message: OutlookSendMessagePayload,
): Promise<void> {
  await request<void>(connection, "/sendMail", {
    method: "POST",
    body: JSON.stringify(message),
  });
}

/** Reply to an existing message. */
export async function replyToMessage(
  connection: OAuthConnection,
  messageId: string,
  comment: string,
): Promise<void> {
  await request<void>(connection, `/messages/${messageId}/reply`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
}

/** List mail folders. */
export async function listMailFolders(
  connection: OAuthConnection,
): Promise<OutlookMailFolder[]> {
  const resp = await request<OutlookMailFolderListResponse>(
    connection,
    "/mailFolders",
    undefined,
    { $top: "100" },
  );
  return resp.value ?? [];
}

/** Mark a message as read. */
export async function markMessageRead(
  connection: OAuthConnection,
  messageId: string,
): Promise<void> {
  await request<void>(connection, `/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ isRead: true }),
  });
}

/** Move a message to a different folder (e.g. for archiving). */
export async function moveMessage(
  connection: OAuthConnection,
  messageId: string,
  destinationFolderId: string,
): Promise<OutlookMessage> {
  return request<OutlookMessage>(connection, `/messages/${messageId}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId: destinationFolderId }),
  });
}

/** Max concurrent individual getMessage requests for batch fetching. */
const BATCH_CONCURRENCY = 5;

/** Fetch multiple messages with concurrency limiting. */
export async function batchGetMessages(
  connection: OAuthConnection,
  messageIds: string[],
  select?: string,
): Promise<OutlookMessage[]> {
  if (messageIds.length === 0) return [];

  if (messageIds.length === 1) {
    return [await getMessage(connection, messageIds[0], select)];
  }

  const results: OutlookMessage[] = [];
  for (let i = 0; i < messageIds.length; i += BATCH_CONCURRENCY) {
    const wave = messageIds.slice(i, i + BATCH_CONCURRENCY);
    const waveResults = await Promise.all(
      wave.map((id) => getMessage(connection, id, select)),
    );
    results.push(...waveResults);
  }
  return results;
}

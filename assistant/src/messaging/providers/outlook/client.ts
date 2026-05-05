import type {
  OAuthConnection,
  OAuthConnectionResponse,
} from "../../../oauth/connection.js";
import type {
  OutlookAttachmentListResponse,
  OutlookAutoReplySettings,
  OutlookDeltaResponse,
  OutlookDraftMessage,
  OutlookFileAttachment,
  OutlookMailFolder,
  OutlookMailFolderListResponse,
  OutlookMasterCategoryListResponse,
  OutlookMessage,
  OutlookMessageFlag,
  OutlookMessageListResponse,
  OutlookMessageRule,
  OutlookMessageRuleListResponse,
  OutlookRecipient,
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

const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "PATCH",
]);

function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Make an authenticated request to the Microsoft Graph API with retry logic.
 *
 * The OAuth provider's baseUrl is `https://graph.microsoft.com`, so all paths
 * must include the full API version and resource prefix (e.g. `/v1.0/me/messages`).
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
      const extraHeaders =
        options?.headers &&
        typeof options.headers === "object" &&
        !Array.isArray(options.headers)
          ? (options.headers as Record<string, string>)
          : {};
      resp = await connection.request({
        method,
        path,
        query,
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
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
  return request<OutlookUserProfile>(connection, "/v1.0/me");
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
    ? `/v1.0/me/mailFolders/${encodeURIComponent(options.folderId)}/messages`
    : "/v1.0/me/messages";

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
    $search: `"${searchQuery.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    $count: "true",
  };
  if (options?.top !== undefined) query["$top"] = String(options.top);
  if (options?.skip !== undefined) query["$skip"] = String(options.skip);

  return request<OutlookMessageListResponse>(
    connection,
    "/v1.0/me/messages",
    {
      headers: {
        ConsistencyLevel: "eventual",
      },
    },
    query,
  );
}

/** Send a new message. */
export async function sendMessage(
  connection: OAuthConnection,
  message: OutlookSendMessagePayload,
): Promise<void> {
  await request<void>(connection, "/v1.0/me/sendMail", {
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
  await request<void>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`,
    {
      method: "POST",
      body: JSON.stringify({ comment }),
    },
  );
}

/** List mail folders. */
export async function listMailFolders(
  connection: OAuthConnection,
): Promise<OutlookMailFolder[]> {
  const allFolders: OutlookMailFolder[] = [];
  let nextQuery: Record<string, string> | undefined = { $top: "100" };

  while (nextQuery) {
    const resp = await request<OutlookMailFolderListResponse>(
      connection,
      "/v1.0/me/mailFolders",
      undefined,
      nextQuery,
    );
    if (resp.value) allFolders.push(...resp.value);
    if (resp["@odata.nextLink"]) {
      const nextUrl = new URL(resp["@odata.nextLink"]);
      nextQuery = {};
      nextUrl.searchParams.forEach((v, k) => {
        nextQuery![k] = v;
      });
    } else {
      nextQuery = undefined;
    }
  }

  return allFolders;
}

/** Mark a message as read. */
export async function markMessageRead(
  connection: OAuthConnection,
  messageId: string,
): Promise<void> {
  await request<void>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    },
  );
}

/** Create a draft message in the user's Drafts folder. */
export async function createDraft(
  connection: OAuthConnection,
  draft: OutlookDraftMessage,
): Promise<OutlookMessage> {
  return request<OutlookMessage>(connection, "/v1.0/me/messages", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

/** Send an existing draft message by its ID. Returns void (202 No Content). */
export async function sendDraft(
  connection: OAuthConnection,
  messageId: string,
): Promise<void> {
  await request<void>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/send`,
    {
      method: "POST",
    },
  );
}

/** Create a reply draft for a message. */
export async function createReplyDraft(
  connection: OAuthConnection,
  messageId: string,
  comment?: string,
): Promise<OutlookMessage> {
  return request<OutlookMessage>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/createReply`,
    {
      method: "POST",
      body: JSON.stringify(comment !== undefined ? { comment } : {}),
    },
  );
}

/** Create a reply-all draft for a message. */
export async function createReplyAllDraft(
  connection: OAuthConnection,
  messageId: string,
  comment?: string,
): Promise<OutlookMessage> {
  return request<OutlookMessage>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/createReplyAll`,
    {
      method: "POST",
      body: JSON.stringify(comment !== undefined ? { comment } : {}),
    },
  );
}

/** Create a forward draft for a message. */
export async function createForwardDraft(
  connection: OAuthConnection,
  messageId: string,
  toRecipients?: OutlookRecipient[],
  comment?: string,
): Promise<OutlookMessage> {
  const body: Record<string, unknown> = {};
  if (toRecipients !== undefined) body.toRecipients = toRecipients;
  if (comment !== undefined) body.comment = comment;

  return request<OutlookMessage>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/createForward`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

/** Max concurrent individual getMessage requests for batch fetching. */

/** List attachments on a message. */
export async function listAttachments(
  connection: OAuthConnection,
  messageId: string,
): Promise<OutlookAttachmentListResponse> {
  return request<OutlookAttachmentListResponse>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments`,
    undefined,
    { $select: "id,name,contentType,size,isInline" },
  );
}

/** Get a single attachment by ID (includes file content). */
export async function getAttachment(
  connection: OAuthConnection,
  messageId: string,
  attachmentId: string,
): Promise<OutlookFileAttachment> {
  return request<OutlookFileAttachment>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

/** Move a message to the Deleted Items folder. */
export async function trashMessage(
  connection: OAuthConnection,
  messageId: string,
): Promise<OutlookMessage> {
  return request<OutlookMessage>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ destinationId: "deleteditems" }),
    },
  );
}

/** List inbox message rules. */
export async function listMailRules(
  connection: OAuthConnection,
): Promise<OutlookMessageRuleListResponse> {
  return request<OutlookMessageRuleListResponse>(
    connection,
    "/v1.0/me/mailFolders/inbox/messageRules",
  );
}

/** Create a new inbox message rule. */
export async function createMailRule(
  connection: OAuthConnection,
  rule: Omit<OutlookMessageRule, "id">,
): Promise<OutlookMessageRule> {
  return request<OutlookMessageRule>(
    connection,
    "/v1.0/me/mailFolders/inbox/messageRules",
    {
      method: "POST",
      body: JSON.stringify(rule),
    },
  );
}

/** Update the categories on a message. */
export async function updateMessageCategories(
  connection: OAuthConnection,
  messageId: string,
  categories: string[],
): Promise<void> {
  await request<void>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ categories }),
    },
  );
}

/** Update the flag on a message. */
export async function updateMessageFlag(
  connection: OAuthConnection,
  messageId: string,
  flag: OutlookMessageFlag,
): Promise<void> {
  await request<void>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ flag }),
    },
  );
}

/** List the user's master categories. */
export async function listMasterCategories(
  connection: OAuthConnection,
): Promise<OutlookMasterCategoryListResponse> {
  return request<OutlookMasterCategoryListResponse>(
    connection,
    "/v1.0/me/outlook/masterCategories",
  );
}

/** Get a message with internet message headers included. */
export async function getMessageWithHeaders(
  connection: OAuthConnection,
  messageId: string,
): Promise<OutlookMessage> {
  return request<OutlookMessage>(
    connection,
    `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    undefined,
    {
      $select:
        "id,subject,from,internetMessageHeaders,bodyPreview,body,hasAttachments,receivedDateTime",
    },
  );
}

/** Delete an inbox message rule by ID. */
export async function deleteMailRule(
  connection: OAuthConnection,
  ruleId: string,
): Promise<void> {
  await request<void>(
    connection,
    `/v1.0/me/mailFolders/inbox/messageRules/${encodeURIComponent(ruleId)}`,
    { method: "DELETE" },
  );
}

/** Get automatic reply (out-of-office) settings. */
export async function getAutoReplySettings(
  connection: OAuthConnection,
): Promise<OutlookAutoReplySettings> {
  return request<OutlookAutoReplySettings>(
    connection,
    "/v1.0/me/mailboxSettings/automaticRepliesSetting",
  );
}

/** Update automatic reply (out-of-office) settings. */
export async function updateAutoReplySettings(
  connection: OAuthConnection,
  settings: OutlookAutoReplySettings,
): Promise<void> {
  await request<void>(connection, "/v1.0/me/mailboxSettings", {
    method: "PATCH",
    body: JSON.stringify({ automaticRepliesSetting: settings }),
  });
}

/**
 * Fetch messages via delta query for incremental sync.
 *
 * On the initial call, omit `deltaLink` to start a fresh delta enumeration
 * for the given folder. On subsequent calls, pass the `@odata.deltaLink`
 * from the previous response to get only changes since then.
 */
export async function listMessagesDelta(
  connection: OAuthConnection,
  folderId: string,
  deltaLink?: string,
): Promise<OutlookDeltaResponse<OutlookMessage>> {
  if (deltaLink) {
    // Parse the deltaLink URL and extract its query params
    const url = new URL(deltaLink);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    return request<OutlookDeltaResponse<OutlookMessage>>(
      connection,
      url.pathname,
      undefined,
      Object.keys(query).length > 0 ? query : undefined,
    );
  }

  return request<OutlookDeltaResponse<OutlookMessage>>(
    connection,
    `/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`,
    undefined,
    {
      $select:
        "id,subject,from,receivedDateTime,isRead,parentFolderId,conversationId,bodyPreview,hasAttachments",
      $top: "50",
    },
  );
}

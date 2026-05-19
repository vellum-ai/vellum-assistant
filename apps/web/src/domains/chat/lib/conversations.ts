/**
 * Conversation CRUD operations and group management.
 *
 * Handles listing, archiving, unarchiving, forking, renaming, reordering,
 * and analyzing conversations, as well as conversation group CRUD.
 */

import * as Sentry from "@sentry/browser";

import {
  ApiError,
  assertHasResponse,
  client,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/domains/chat/lib/client.js";

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface Conversation {
  conversationKey: string;
  title?: string;
  createdAt?: string;
  lastMessageAt?: string;
  hasUnseenLatestAssistantMessage?: boolean;
  latestAssistantMessageAt?: string;
  lastSeenAssistantMessageAt?: string;
  archivedAt?: number;
  groupId?: string;
  source?: string;
  isPinned?: boolean;
  conversationType?: string;
  scheduleJobId?: string;
  /**
   * Channel of origin for this conversation, e.g. `"slack"`, `"telegram"`,
   * `"phone"`, `"vellum"`, or `"notification:*"`. Sourced from the daemon's
   * `channelBinding.sourceChannel` (when present) and falling back to
   * `conversationOriginChannel`. Used by `isChannelConversation` to gate
   * read-only behavior for externally-bound conversations.
   */
  originChannel?: string;
  /** True for optimistic stubs not yet confirmed by the server. */
  draft?: boolean;
}

interface ListConversationsResponse {
  conversations: Conversation[];
}

interface ConversationAttentionPayload {
  hasUnseenLatestAssistantMessage?: unknown;
  latestAssistantMessageAt?: unknown;
  lastSeenAssistantMessageAt?: unknown;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

export function parseConversation(raw: unknown): Conversation | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  const conversationKey =
    typeof record.conversationKey === "string"
      ? record.conversationKey
      : typeof record.id === "string"
        ? record.id
        : null;

  if (!conversationKey) return null;

  const attention =
    record.assistantAttention &&
      typeof record.assistantAttention === "object"
      ? (record.assistantAttention as ConversationAttentionPayload)
      : undefined;

  const title =
    typeof record.title === "string" ? record.title : undefined;

  const channelBinding =
    record.channelBinding && typeof record.channelBinding === "object"
      ? (record.channelBinding as Record<string, unknown>)
      : null;
  const bindingSourceChannel =
    channelBinding && typeof channelBinding.sourceChannel === "string"
      ? channelBinding.sourceChannel
      : undefined;
  const conversationOriginChannel =
    typeof record.conversationOriginChannel === "string"
      ? record.conversationOriginChannel
      : undefined;
  // Match the macOS coalescing order in ConversationRestorer.swift:
  //   channelBinding?.sourceChannel ?? conversationOriginChannel
  const originChannel = bindingSourceChannel ?? conversationOriginChannel;

  return {
    conversationKey,
    title,
    createdAt: normalizeTimestamp(record.createdAt),
    lastMessageAt: normalizeTimestamp(record.lastMessageAt ?? record.updatedAt),
    hasUnseenLatestAssistantMessage:
      typeof attention?.hasUnseenLatestAssistantMessage === "boolean"
        ? attention.hasUnseenLatestAssistantMessage
        : undefined,
    latestAssistantMessageAt: normalizeTimestamp(
      attention?.latestAssistantMessageAt,
    ),
    lastSeenAssistantMessageAt: normalizeTimestamp(
      attention?.lastSeenAssistantMessageAt,
    ),
    archivedAt:
      typeof record.archivedAt === "number" ? record.archivedAt : undefined,
    groupId:
      typeof record.groupId === "string" ? record.groupId : undefined,
    source:
      typeof record.source === "string" ? record.source : undefined,
    isPinned:
      typeof record.isPinned === "boolean" ? record.isPinned : undefined,
    conversationType:
      typeof record.conversationType === "string" ? record.conversationType : undefined,
    scheduleJobId:
      typeof record.scheduleJobId === "string" ? record.scheduleJobId : undefined,
    originChannel,
  };
}

async function fetchConversationList(
  assistantId: string,
  conversationType?: "background",
): Promise<Conversation[]> {
  const { data, error, response } = await client.get<
    ListConversationsResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/",
    path: { assistant_id: assistantId },
    query: conversationType ? { conversationType } : undefined,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list conversations.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to list conversations.");
    throw new ApiError(response.status, msg);
  }
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as unknown as {
          conversations?: unknown;
          sessions?: unknown;
        })
      : null;
  const rawItems = Array.isArray(payload?.conversations)
    ? payload.conversations
    : Array.isArray(payload?.sessions)
      ? payload.sessions
      : [];

  return rawItems
    .map((conversation) => parseConversation(conversation))
    .filter((conversation): conversation is Conversation => conversation !== null);
}

/**
 * Fetch all conversations (foreground + background) for a given assistant.
 * The daemon filters conversation types server-side: the default list excludes
 * background/scheduled conversations, and `?conversationType=background` returns
 * only background/scheduled. Both are fetched in parallel and merged so the
 * sidebar can display every conversation type. Returns sorted newest-first.
 *
 * The background fetch is best-effort: if it fails (e.g. transient server
 * error, or the daemon predates `?conversationType=background` support), the
 * foreground list is still returned so the sidebar remains usable. A foreground
 * failure continues to throw, since no conversations could be shown anyway.
 */
export async function listConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const [foregroundResult, backgroundResult] = await Promise.allSettled([
    fetchConversationList(assistantId),
    fetchConversationList(assistantId, "background"),
  ]);

  if (foregroundResult.status === "rejected") {
    throw foregroundResult.reason;
  }

  const foreground = foregroundResult.value;
  let background: Conversation[] = [];
  if (backgroundResult.status === "fulfilled") {
    background = backgroundResult.value;
  } else {
    Sentry.captureException(backgroundResult.reason, {
      level: "warning",
      tags: { context: "listConversations.backgroundFetch" },
      extra: { assistantId },
    });
  }

  const seen = new Set<string>();
  const conversations: Conversation[] = [];
  for (const conversation of [...foreground, ...background]) {
    if (seen.has(conversation.conversationKey)) {
      continue;
    }
    seen.add(conversation.conversationKey);
    conversations.push(conversation);
  }

  conversations.sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });

  return conversations;
}

/**
 * True when a conversation is a background/scheduled conversation (either by
 * explicit `conversationType` or by legacy `system:background` / `system:scheduled`
 * group id). Background conversations are hidden behind a collapsed-by-default
 * sidebar section, so they should not be auto-selected as the default landing
 * conversation.
 */
export function isBackgroundConversation(conversation: Conversation): boolean {
  return (
    conversation.conversationType === "background" ||
    conversation.conversationType === "scheduled" ||
    conversation.groupId === "system:background" ||
    conversation.groupId === "system:scheduled"
  );
}

/**
 * True when the row's "Mark as unread" action should be enabled. Mirrors
 * the macOS rule: there must be an assistant message to unread, the
 * conversation must not already be unread, must not be a background or
 * scheduled conversation (those don't support unread state), and must
 * have a server-side identifier.
 */
export function canMarkUnread(conversation: Conversation): boolean {
  return (
    !conversation.hasUnseenLatestAssistantMessage &&
    !isBackgroundConversation(conversation) &&
    conversation.conversationKey != null &&
    conversation.latestAssistantMessageAt != null
  );
}

/**
 * True when the row's "Mark as read" action should be enabled. The
 * conversation must currently be unread and must have a server-side
 * identifier. Background / scheduled conversations are excluded because
 * they already suppress the unread indicator.
 */
export function canMarkRead(conversation: Conversation): boolean {
  return (
    conversation.hasUnseenLatestAssistantMessage === true &&
    !isBackgroundConversation(conversation) &&
    conversation.conversationKey != null
  );
}

async function postConversationAttentionAction(
  endpoint: "seen" | "unread",
  assistantId: string,
  conversationKey: string,
): Promise<void> {
  const request = client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: `/v1/assistants/{assistant_id}/conversations/${endpoint}/`,
    path: { assistant_id: assistantId },
    body: { conversationId: conversationKey },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });

  const { error, response } = await request;
  assertHasResponse(
    response,
    error,
    `Failed to mark conversation ${endpoint}.`,
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      `Failed to mark conversation ${endpoint}.`,
    );
    throw new ApiError(response.status, msg);
  }
}

export async function markConversationSeen(
  assistantId: string,
  conversationKey: string,
): Promise<void> {
  await postConversationAttentionAction("seen", assistantId, conversationKey);
}

export async function markConversationUnread(
  assistantId: string,
  conversationKey: string,
): Promise<void> {
  await postConversationAttentionAction("unread", assistantId, conversationKey);
}

export async function archiveConversation(
  assistantId: string,
  conversationKey: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/{conversation_id}/archive",
    path: { assistant_id: assistantId, conversation_id: conversationKey },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to archive conversation.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to archive conversation.",
    );
    throw new ApiError(response.status, msg);
  }
}

export async function unarchiveConversation(
  assistantId: string,
  conversationKey: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/{conversation_id}/unarchive",
    path: { assistant_id: assistantId, conversation_id: conversationKey },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to unarchive conversation.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to unarchive conversation.",
    );
    throw new ApiError(response.status, msg);
  }
}

// No generated endpoint exists for the analyze route yet; using the legacy client
// to match the pattern of other conversation operations in this file.
export async function analyzeConversation(
  assistantId: string,
  conversationKey: string,
): Promise<{ conversationKey: string }> {
  const { data, error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/{conversation_id}/analyze",
    path: { assistant_id: assistantId, conversation_id: conversationKey },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to analyze conversation.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to analyze conversation.",
    );
    throw new ApiError(response.status, msg);
  }

  const conversationObj =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { conversation?: unknown }).conversation
      : undefined;
  const newConversationId =
    conversationObj &&
    typeof conversationObj === "object" &&
    !Array.isArray(conversationObj)
      ? (conversationObj as { id?: unknown }).id
      : undefined;

  if (typeof newConversationId !== "string" || newConversationId.length === 0) {
    throw new ApiError(
      response.status,
      "Analyze response did not include a conversation id.",
    );
  }

  return { conversationKey: newConversationId };
}

export async function cancelGeneration(
  assistantId: string,
  conversationKey: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/{conversation_id}/cancel",
    path: { assistant_id: assistantId, conversation_id: conversationKey },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to cancel generation.");
  if (!response.ok && response.status !== 202) {
    const msg = extractErrorMessage(error, response, "Failed to cancel generation.");
    throw new ApiError(response.status, msg);
  }
}

/**
 * Abort a running subagent via the daemon's dedicated subagent abort endpoint.
 * Matches macOS `SubagentClient.abort()`.
 */
export async function abortSubagent(
  assistantId: string,
  conversationKey: string,
  subagentId: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/subagents/{subagent_id}/abort",
    path: { assistant_id: assistantId, subagent_id: subagentId },
    body: { conversationId: conversationKey },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to abort subagent.");
  if (!response.ok && response.status !== 404) {
    const msg = extractErrorMessage(error, response, "Failed to abort subagent.");
    throw new ApiError(response.status, msg);
  }
}

// No generated endpoint exists for the fork route yet; using the legacy client
// to match the pattern of other conversation operations in this file.
export async function forkConversation(
  assistantId: string,
  conversationId: string,
  throughMessageId?: string,
): Promise<{ conversationId: string }> {
  const { data, error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/fork",
    path: { assistant_id: assistantId },
    body: { conversationId, throughMessageId },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to fork conversation.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fork conversation.",
    );
    throw new ApiError(response.status, msg);
  }

  const conversationObj =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { conversation?: unknown }).conversation
      : undefined;
  const newConversationId =
    conversationObj &&
    typeof conversationObj === "object" &&
    !Array.isArray(conversationObj)
      ? (conversationObj as { id?: unknown }).id
      : undefined;

  if (typeof newConversationId !== "string" || newConversationId.length === 0) {
    throw new ApiError(
      response.status,
      "Fork response did not include a conversation id.",
    );
  }

  return { conversationId: newConversationId };
}

// No generated endpoint exists for the rename route yet; using the legacy client
// to match the pattern of other conversation operations in this file.
export async function renameConversation(
  assistantId: string,
  conversationKey: string,
  name: string,
): Promise<void> {
  const { error, response } = await client.patch<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/{conversation_id}/name",
    path: { assistant_id: assistantId, conversation_id: conversationKey },
    body: { name },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to rename conversation.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to rename conversation.",
    );
    throw new ApiError(response.status, msg);
  }
}

// No generated endpoint exists for the reorder route yet; using the legacy client
// to match the pattern of other conversation operations in this file.
export interface ReorderConversationUpdate {
  conversationId: string;
  isPinned: boolean;
  displayOrder?: number;
  groupId?: string | null;
}

export async function reorderConversations(
  assistantId: string,
  updates: ReorderConversationUpdate[],
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversations/reorder/",
    path: { assistant_id: assistantId },
    body: { updates },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to reorder conversations.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to reorder conversations.",
    );
    throw new ApiError(response.status, msg);
  }
}

// ---------------------------------------------------------------------------
// Conversation Groups
// ---------------------------------------------------------------------------

export interface ConversationGroup {
  id: string;
  name: string;
  sortPosition: number;
  isSystemGroup: boolean;
}

export async function fetchGroups(
  assistantId: string,
): Promise<ConversationGroup[]> {
  const { data, error, response } = await client.get<
    { groups?: unknown },
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/groups/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list groups.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to list groups.");
    throw new ApiError(response.status, msg);
  }

  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { groups?: unknown })
      : null;
  const rawItems = Array.isArray(payload?.groups) ? payload.groups : [];
  return rawItems.filter(
    (g): g is ConversationGroup =>
      !!g &&
      typeof g === "object" &&
      typeof (g as Record<string, unknown>).id === "string" &&
      typeof (g as Record<string, unknown>).name === "string" &&
      typeof (g as Record<string, unknown>).sortPosition === "number" &&
      typeof (g as Record<string, unknown>).isSystemGroup === "boolean",
  );
}

export async function createGroup(
  assistantId: string,
  name: string,
): Promise<ConversationGroup> {
  const { data, error, response } = await client.post<ConversationGroup, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/groups/",
    path: { assistant_id: assistantId },
    body: { name },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to create group.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to create group.");
    throw new ApiError(response.status, msg);
  }
  if (!data || typeof data !== "object" || typeof (data as unknown as Record<string, unknown>).id !== "string") {
    throw new ApiError(response.status, "Create group response did not include a valid group.");
  }
  return data;
}

export async function updateGroup(
  assistantId: string,
  groupId: string,
  opts: { name?: string; sortPosition?: number },
): Promise<void> {
  const { error, response } = await client.patch<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/groups/{group_id}/",
    path: { assistant_id: assistantId, group_id: groupId },
    body: opts,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update group.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to update group.");
    throw new ApiError(response.status, msg);
  }
}

export async function deleteGroup(
  assistantId: string,
  groupId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/groups/{group_id}/",
    path: { assistant_id: assistantId, group_id: groupId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete group.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to delete group.");
    throw new ApiError(response.status, msg);
  }
}

export async function reorderGroups(
  assistantId: string,
  updates: { groupId: string; sortPosition: number }[],
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/groups/reorder/",
    path: { assistant_id: assistantId },
    body: { updates },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to reorder groups.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to reorder groups.");
    throw new ApiError(response.status, msg);
  }
}

// ---------------------------------------------------------------------------
// Subagent detail
// ---------------------------------------------------------------------------

/** Response shape from the daemon's `GET /subagents/:id` endpoint. */
export interface SubagentDetailResponse {
  subagentId: string;
  status?: string;
  objective?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
  events: Array<Record<string, unknown>>;
}

/**
 * Fetch subagent detail (objective, usage, events) from the daemon.
 *
 * The wildcard proxy in Django forwards unmatched
 * `/v1/assistants/<id>/subagents/...` paths to the daemon.
 */
export async function fetchSubagentDetail(
  assistantId: string,
  subagentId: string,
  conversationId: string,
): Promise<SubagentDetailResponse | null> {
  try {
    const { data, response } = await client.get<SubagentDetailResponse, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/subagents/{subagent_id}",
      path: { assistant_id: assistantId, subagent_id: subagentId },
      query: { conversationId },
      throwOnError: false,
    });
    if (!response || !response.ok || !data) {
      return null;
    }
    return data;
  } catch (err) {
    Sentry.captureException(err, { tags: { operation: "fetchSubagentDetail" } });
    return null;
  }
}

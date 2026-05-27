/**
 * Conversation CRUD operations via the generated daemon SDK.
 *
 * Handles listing, archiving, unarchiving, forking, renaming, reordering,
 * and analyzing conversations.
 *
 * The `Conversation` interface is a normalized client-side representation
 * (timestamps as ISO strings, attention fields flattened, `id` renamed to
 * `conversationId`). `parseConversation` transforms the raw daemon response
 * into this shape. `ConversationGroup` is re-exported from the generated SDK.
 */

import * as Sentry from "@sentry/browser";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  conversationsByIdAnalyzePost,
  conversationsByIdArchivePost,
  conversationsByIdCancelPost,
  conversationsByIdGet,
  conversationsByIdNamePatch,
  conversationsByIdUnarchivePost,
  conversationsForkPost,
  conversationsReorderPost,
  conversationsSeenPost,
  conversationsUnreadPost,
  subagentsByIdAbortPost,
  subagentsByIdGet,
} from "@/generated/daemon/sdk.gen";
import type {
  ConversationsGetResponse,
  ConversationsGetResponses,
  GroupsGetResponse,
} from "@/generated/daemon/types.gen";

import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors";
import {
  parseSlackMessageLink,
  type SlackMessageLink,
} from "@/utils/slack-message-link";

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface Conversation {
  conversationId: string;
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
   * Server-provided sort order for pinned and custom-group buckets. Set when
   * the user has drag-reordered the conversation; absent for conversations
   * that have never been reordered. Consumers (see `groupConversations`)
   * should sort pinned / custom-group buckets by this field so the user's
   * order is preserved across reloads.
   */
  displayOrder?: number;
  channelBinding?: ConversationChannelBinding;
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

export interface ConversationChannelBinding {
  sourceChannel: string;
  externalChatId: string;
  externalThreadId?: string;
  externalChatName?: string;
  externalUserId?: string;
  displayName?: string;
  username?: string;
  slackChannel?: ConversationSlackChannel;
  slackThread?: ConversationSlackThread;
}

export interface ConversationSlackChannel {
  id?: string;
  channelId?: string;
  name?: string;
  link?: string | SlackMessageLink;
}

export interface ConversationSlackThread {
  channelId: string;
  threadTs: string;
  link?: SlackMessageLink;
}

// Re-export group type from generated SDK
export type ConversationGroup = GroupsGetResponse["groups"][number];

// ---------------------------------------------------------------------------
// Parsing helpers — transform raw daemon payloads into Conversation shape
// ---------------------------------------------------------------------------

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function parseSlackChannel(raw: unknown): ConversationSlackChannel | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  const channelId =
    typeof record.channelId === "string" ? record.channelId : undefined;
  if (!id && !channelId) return undefined;

  const link =
    typeof record.link === "string"
      ? record.link
      : parseSlackMessageLink(record.link);
  const hasLink =
    typeof link === "string" ||
    (typeof link === "object" && (Boolean(link.appUrl) || Boolean(link.webUrl)));

  return {
    ...(id ? { id } : {}),
    ...(channelId ? { channelId } : {}),
    name: typeof record.name === "string" ? record.name : undefined,
    ...(hasLink ? { link } : {}),
  };
}

function parseSlackThread(raw: unknown): ConversationSlackThread | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const record = raw as Record<string, unknown>;
  if (
    typeof record.channelId !== "string" ||
    typeof record.threadTs !== "string"
  ) {
    return undefined;
  }

  const link = parseSlackMessageLink(record.link);

  return {
    channelId: record.channelId,
    threadTs: record.threadTs,
    ...(link?.appUrl || link?.webUrl ? { link } : {}),
  };
}

function parseChannelBinding(
  raw: unknown,
): ConversationChannelBinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const record = raw as Record<string, unknown>;
  if (
    typeof record.sourceChannel !== "string" ||
    typeof record.externalChatId !== "string"
  ) {
    return undefined;
  }

  const slackChannel = parseSlackChannel(record.slackChannel);
  const slackThread = parseSlackThread(record.slackThread);

  return {
    sourceChannel: record.sourceChannel,
    externalChatId: record.externalChatId,
    externalThreadId:
      typeof record.externalThreadId === "string"
        ? record.externalThreadId
        : undefined,
    externalChatName:
      typeof record.externalChatName === "string"
        ? record.externalChatName
        : undefined,
    externalUserId:
      typeof record.externalUserId === "string"
        ? record.externalUserId
        : undefined,
    displayName:
      typeof record.displayName === "string"
        ? record.displayName
        : undefined,
    username:
      typeof record.username === "string" ? record.username : undefined,
    ...(slackChannel ? { slackChannel } : {}),
    ...(slackThread ? { slackThread } : {}),
  };
}

export function parseConversation(raw: unknown): Conversation | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  // Read `conversationId` (the canonical entity field name) with `id` as a
  // synonym. The daemon's `serializeConversationSummary` emits `id` only
  // today; `conversationId` exists for forward compatibility (LUM-1890).
  const conversationId =
    typeof record.conversationId === "string"
      ? record.conversationId
      : typeof record.id === "string"
        ? record.id
        : null;

  if (!conversationId) return null;

  const attention =
    record.assistantAttention &&
    typeof record.assistantAttention === "object"
      ? (record.assistantAttention as ConversationAttentionPayload)
      : undefined;

  const channelBinding =
    record.channelBinding && typeof record.channelBinding === "object"
      ? (record.channelBinding as Record<string, unknown>)
      : null;
  const parsedChannelBinding = parseChannelBinding(channelBinding);
  // Read sourceChannel from the raw binding (before strict parsing) so
  // originChannel is populated even when externalChatId is absent.
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
    conversationId,
    title: typeof record.title === "string" ? record.title : undefined,
    createdAt: normalizeTimestamp(record.createdAt),
    lastMessageAt: normalizeTimestamp(
      record.lastMessageAt ?? record.updatedAt,
    ),
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
    displayOrder:
      typeof record.displayOrder === "number" && Number.isFinite(record.displayOrder)
        ? record.displayOrder
        : undefined,
    channelBinding: parsedChannelBinding,
    originChannel,
  };
}

// ---------------------------------------------------------------------------
// Conversation list fetching with pagination
// ---------------------------------------------------------------------------

interface ConversationAttentionPayload {
  hasUnseenLatestAssistantMessage?: unknown;
  latestAssistantMessageAt?: unknown;
  lastSeenAssistantMessageAt?: unknown;
}

const CONVERSATION_LIST_PAGE_SIZE = 50;
const CONVERSATION_LIST_MAX_PAGES = 200;

async function fetchConversationList(
  assistantId: string,
  conversationType?: "background",
): Promise<Conversation[]> {
  const all: Conversation[] = [];

  for (let page = 0; page < CONVERSATION_LIST_MAX_PAGES; page++) {
    const offset = page * CONVERSATION_LIST_PAGE_SIZE;
    // The daemon route definition doesn't declare query parameters, so the
    // generated SDK type has `query?: never`. Use the raw daemon client for
    // the paginated list call.
    const { data, error, response } = await daemonClient.get<
      ConversationsGetResponses
    >({
      url: "/v1/assistants/{assistant_id}/conversations",
      path: { assistant_id: assistantId },
      query: {
        ...(conversationType ? { conversationType } : {}),
        limit: CONVERSATION_LIST_PAGE_SIZE,
        offset,
      },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to list conversations.");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response, "Failed to list conversations.");
      throw new ApiError(response.status, msg);
    }

    const payload = data as ConversationsGetResponse | undefined;
    const rawItems = payload?.conversations ?? [];
    const pageItems = rawItems
      .map((conversation) => parseConversation(conversation))
      .filter((conversation): conversation is Conversation => conversation !== null);

    all.push(...pageItems);

    const hasMore = payload?.hasMore ?? false;
    if (!hasMore) break;

    if (pageItems.length === 0) break;
  }

  return all;
}

/**
 * Indicates the conversation existed at request time but the server reported
 * it as deleted (HTTP 404). Callers use this sentinel to remove the row from
 * the cached list rather than treat the absence as a transient network error.
 */
export const CONVERSATION_NOT_FOUND = Symbol(
  "vellum.conversation-not-found",
);

export type FetchConversationDetailResult =
  | Conversation
  | typeof CONVERSATION_NOT_FOUND;

/**
 * Fetch a single conversation row in list-row shape. Used by
 * `refreshConversationRow` to GET-and-patch the cached sidebar list.
 *
 * Returns the parsed row, or the `CONVERSATION_NOT_FOUND` sentinel when
 * the server reports the conversation no longer exists.
 */
export async function fetchConversationDetail(
  assistantId: string,
  conversationId: string,
): Promise<FetchConversationDetailResult> {
  const { data, error, response } = await conversationsByIdGet({
    path: { assistant_id: assistantId, id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch conversation.");
  if (response.status === 404) {
    return CONVERSATION_NOT_FOUND;
  }
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch conversation.",
    );
    throw new ApiError(response.status, msg);
  }
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { conversation?: unknown })
      : null;
  const parsed = parseConversation(payload?.conversation ?? null);
  if (!parsed) {
    throw new ApiError(
      response.status,
      "Conversation detail payload was malformed.",
    );
  }
  return parsed;
}

/**
 * Fetch all conversations (foreground + background) for a given assistant.
 * Both are fetched in parallel and merged so the sidebar can display every
 * conversation type. Returns sorted newest-first.
 *
 * The background fetch is best-effort: if it fails the foreground list is
 * still returned so the sidebar remains usable.
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
    if (seen.has(conversation.conversationId)) {
      continue;
    }
    seen.add(conversation.conversationId);
    conversations.push(conversation);
  }

  conversations.sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });

  return conversations;
}

// ---------------------------------------------------------------------------
// Conversation predicates
// ---------------------------------------------------------------------------

export function isBackgroundConversation(conversation: Conversation): boolean {
  return (
    conversation.conversationType === "background" ||
    conversation.conversationType === "scheduled" ||
    conversation.groupId === "system:background" ||
    conversation.groupId === "system:scheduled"
  );
}

export function canMarkUnread(conversation: Conversation): boolean {
  return (
    !conversation.hasUnseenLatestAssistantMessage &&
    !isBackgroundConversation(conversation) &&
    conversation.conversationId != null &&
    conversation.latestAssistantMessageAt != null
  );
}

export function canMarkRead(conversation: Conversation): boolean {
  return (
    conversation.hasUnseenLatestAssistantMessage === true &&
    !isBackgroundConversation(conversation) &&
    conversation.conversationId != null
  );
}

// ---------------------------------------------------------------------------
// Conversation mutations
// ---------------------------------------------------------------------------

async function postConversationAttentionAction(
  endpoint: "seen" | "unread",
  assistantId: string,
  conversationId: string,
): Promise<void> {
  const fn = endpoint === "seen" ? conversationsSeenPost : conversationsUnreadPost;
  const { error, response } = await fn({
    path: { assistant_id: assistantId },
    body: { conversationId },
    throwOnError: false,
  });
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
  conversationId: string,
): Promise<void> {
  await postConversationAttentionAction("seen", assistantId, conversationId);
}

export async function markConversationUnread(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  await postConversationAttentionAction("unread", assistantId, conversationId);
}

export async function archiveConversation(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  const { error, response } = await conversationsByIdArchivePost({
    path: { assistant_id: assistantId, id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to archive conversation.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to archive conversation.");
    throw new ApiError(response.status, msg);
  }
}

export async function unarchiveConversation(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  const { error, response } = await conversationsByIdUnarchivePost({
    path: { assistant_id: assistantId, id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to unarchive conversation.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to unarchive conversation.");
    throw new ApiError(response.status, msg);
  }
}

export async function analyzeConversation(
  assistantId: string,
  conversationId: string,
): Promise<{ conversationId: string }> {
  const { data, error, response } = await conversationsByIdAnalyzePost({
    path: { assistant_id: assistantId, id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to analyze conversation.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to analyze conversation.");
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

  return { conversationId: newConversationId };
}

export async function cancelGeneration(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  const { error, response } = await conversationsByIdCancelPost({
    path: { assistant_id: assistantId, id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to cancel generation.");
  if (!response.ok && response.status !== 202) {
    const msg = extractErrorMessage(error, response, "Failed to cancel generation.");
    throw new ApiError(response.status, msg);
  }
}

export async function abortSubagent(
  assistantId: string,
  conversationId: string,
  subagentId: string,
): Promise<void> {
  const { error, response } = await subagentsByIdAbortPost({
    path: { assistant_id: assistantId, id: subagentId },
    body: { conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to abort subagent.");
  if (!response.ok && response.status !== 404) {
    const msg = extractErrorMessage(error, response, "Failed to abort subagent.");
    throw new ApiError(response.status, msg);
  }
}

export async function forkConversation(
  assistantId: string,
  conversationId: string,
  throughMessageId?: string,
): Promise<{ conversationId: string }> {
  const { data, error, response } = await conversationsForkPost({
    path: { assistant_id: assistantId },
    body: { conversationId, throughMessageId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fork conversation.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to fork conversation.");
    throw new ApiError(response.status, msg);
  }

  const newConversationId =
    data && typeof data === "object" && "conversation" in data
      ? (data.conversation as { id?: string })?.id
      : undefined;

  if (typeof newConversationId !== "string" || newConversationId.length === 0) {
    throw new ApiError(
      response.status,
      "Fork response did not include a conversation id.",
    );
  }

  return { conversationId: newConversationId };
}

export async function renameConversation(
  assistantId: string,
  conversationId: string,
  name: string,
): Promise<void> {
  const { error, response } = await conversationsByIdNamePatch({
    path: { assistant_id: assistantId, id: conversationId },
    body: { name },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to rename conversation.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to rename conversation.");
    throw new ApiError(response.status, msg);
  }
}

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
  const { error, response } = await conversationsReorderPost({
    path: { assistant_id: assistantId },
    body: { updates },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to reorder conversations.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to reorder conversations.");
    throw new ApiError(response.status, msg);
  }
}

// ---------------------------------------------------------------------------
// Subagent detail
// ---------------------------------------------------------------------------

/**
 * Subagent event shape returned by the daemon. The daemon route schema
 * declares `events: z.array(z.unknown())` so the generated type is
 * `Array<unknown>`. This interface reflects the actual runtime shape
 * from `parseSubagentMessages()` in the daemon's subagents-routes.ts.
 */
export interface SubagentEvent {
  type: string;
  content: string;
  toolName?: string;
  isError?: boolean;
  messageId?: string;
  text?: string;
  result?: string;
  timestamp?: number;
}

export interface SubagentDetailResponse {
  subagentId: string;
  objective: string;
  status?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
  events: SubagentEvent[];
}

export async function fetchSubagentDetail(
  assistantId: string,
  subagentId: string,
  conversationId: string,
): Promise<SubagentDetailResponse | null> {
  try {
    const { data, response } = await subagentsByIdGet({
      path: { assistant_id: assistantId, id: subagentId },
      query: { conversationId },
      throwOnError: false,
    });
    if (!response || !response.ok || !data) {
      return null;
    }
    // The generated SDK types events as `Array<unknown>` because the
    // daemon schema uses `z.array(z.unknown())`. Cast to the known
    // runtime shape from `parseSubagentMessages()`.
    return data as unknown as SubagentDetailResponse;
  } catch (err) {
    Sentry.captureException(err, { tags: { operation: "fetchSubagentDetail" } });
    return null;
  }
}

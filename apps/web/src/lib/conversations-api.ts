/**
 * Conversation data layer: listing, detail, predicates, and transforms.
 *
 * All daemon calls use the generated SDK (`@/generated/daemon/sdk.gen`).
 * The `Conversation` interface is a normalized client-side representation
 * (timestamps as epoch-ms numbers, attention fields flattened, `id` renamed
 * to `conversationId`). `toConversation` transforms the typed daemon response
 * into this shape. `ConversationGroup` is re-exported from the generated SDK.
 */

import * as Sentry from "@sentry/browser";

import {
  conversationsByIdGet,
  conversationsGet,
  subagentsByIdGet,
} from "@/generated/daemon/sdk.gen";
import type {
  ConversationsByIdGetResponse,
  ConversationsGetResponse,
  GroupsGetResponse,
} from "@/generated/daemon/types.gen";

import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors";
import type { SlackMessageLink } from "@/utils/slack-message-link";

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface Conversation {
  conversationId: string;
  title?: string;
  createdAt?: number;
  lastMessageAt?: number;
  hasUnseenLatestAssistantMessage?: boolean;
  latestAssistantMessageAt?: number;
  lastSeenAssistantMessageAt?: number;
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
  channelId?: string;
  name?: string;
  link?: SlackMessageLink;
}

export interface ConversationSlackThread {
  channelId: string;
  threadTs: string;
  link?: SlackMessageLink;
}

// Re-export group type from generated SDK
export type ConversationGroup = GroupsGetResponse["groups"][number];

// ---------------------------------------------------------------------------
// Raw daemon conversation type + typed transform
// ---------------------------------------------------------------------------

/** Single conversation row from the generated daemon SDK response. */
export type RawConversationSummary =
  ConversationsGetResponse["conversations"][number];

/** Single conversation detail from the generated daemon SDK response. */
type RawConversationDetail =
  ConversationsByIdGetResponse["conversation"];

function asNumber(value: number | unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: string | unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapChannelBinding(
  raw: RawConversationSummary["channelBinding"],
): ConversationChannelBinding | undefined {
  if (!raw) return undefined;
  return {
    sourceChannel: raw.sourceChannel,
    externalChatId: raw.externalChatId,
    externalThreadId: raw.externalThreadId,
    externalChatName: raw.externalChatName,
    externalUserId: asString(raw.externalUserId),
    displayName: asString(raw.displayName),
    username: asString(raw.username),
    slackChannel: raw.slackChannel
      ? {
          channelId: raw.slackChannel.channelId,
          name: raw.slackChannel.name,
          link: raw.slackChannel.link?.webUrl
            ? { webUrl: raw.slackChannel.link.webUrl }
            : undefined,
        }
      : undefined,
    slackThread: raw.slackThread
      ? {
          channelId: raw.slackThread.channelId,
          threadTs: raw.slackThread.threadTs,
          link:
            raw.slackThread.link?.appUrl || raw.slackThread.link?.webUrl
              ? {
                  appUrl: raw.slackThread.link.appUrl,
                  webUrl: raw.slackThread.link.webUrl,
                }
              : undefined,
        }
      : undefined,
  };
}

/**
 * Transform a typed daemon conversation summary into the client-side
 * `Conversation` shape. Handles `id` → `conversationId` rename,
 * attention field flattening, and `originChannel` coalescing.
 * Timestamps pass through as epoch-ms numbers.
 */
export function toConversation(raw: RawConversationSummary): Conversation {
  const attention = raw.assistantAttention;
  // Match the macOS coalescing order in ConversationRestorer.swift:
  //   channelBinding?.sourceChannel ?? conversationOriginChannel
  const originChannel =
    raw.channelBinding?.sourceChannel ??
    asString(raw.conversationOriginChannel);

  return {
    conversationId: raw.id,
    title: raw.title,
    createdAt: asNumber(raw.createdAt),
    lastMessageAt: asNumber(raw.lastMessageAt ?? raw.updatedAt),
    hasUnseenLatestAssistantMessage:
      attention?.hasUnseenLatestAssistantMessage,
    latestAssistantMessageAt: asNumber(attention?.latestAssistantMessageAt),
    lastSeenAssistantMessageAt: asNumber(
      attention?.lastSeenAssistantMessageAt,
    ),
    archivedAt: raw.archivedAt,
    groupId: asString(raw.groupId),
    source: raw.source,
    isPinned: raw.isPinned,
    conversationType: raw.conversationType,
    scheduleJobId: raw.scheduleJobId,
    displayOrder: asNumber(raw.displayOrder),
    channelBinding: mapChannelBinding(raw.channelBinding),
    originChannel,
  };
}

/**
 * Transform a typed daemon conversation detail into the client-side
 * `Conversation` shape. The detail response shares the same structure
 * as summary rows.
 */
function detailToConversation(
  raw: RawConversationDetail,
): Conversation {
  // The detail and summary types share the same shape from the daemon
  // serializer. Cast is safe because both are produced by
  // `serializeConversationSummary` in the daemon.
  return toConversation(raw as RawConversationSummary);
}

// ---------------------------------------------------------------------------
// Conversation list fetching with pagination
// ---------------------------------------------------------------------------

const CONVERSATION_LIST_PAGE_SIZE = 50;
const CONVERSATION_LIST_MAX_PAGES = 200;

async function fetchConversationList(
  assistantId: string,
  conversationType?: "background",
): Promise<Conversation[]> {
  const all: Conversation[] = [];

  for (let page = 0; page < CONVERSATION_LIST_MAX_PAGES; page++) {
    const offset = page * CONVERSATION_LIST_PAGE_SIZE;
    const { data, error, response } = await conversationsGet({
      path: { assistant_id: assistantId },
      query: {
        limit: CONVERSATION_LIST_PAGE_SIZE,
        offset,
        ...(conversationType ? { conversationType } : {}),
      },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to list conversations.");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response, "Failed to list conversations.");
      throw new ApiError(response.status, msg);
    }

    const conversations = data?.conversations ?? [];
    all.push(...conversations.map(toConversation));

    const hasMore = data?.hasMore ?? false;
    if (!hasMore) break;

    if (conversations.length === 0) break;
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
  if (!data?.conversation) {
    throw new ApiError(
      response.status,
      "Conversation detail payload was malformed.",
    );
  }
  return detailToConversation(data.conversation);
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

  conversations.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

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

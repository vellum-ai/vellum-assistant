/**
 * Route handlers for conversation listing, detail, and seen/unread state.
 *
 * GET    /v1/conversations          — paginated conversation list
 * POST   /v1/conversations/seen     — record a seen signal
 * POST   /v1/conversations/unread   — mark a conversation unread
 * GET    /v1/conversations/:id      — conversation detail
 */

import {
  type Confidence,
  getAttentionStateByConversationIds,
  markConversationUnread,
  recordConversationSeenSignal,
  type SignalType,
} from "../../memory/conversation-attention-store.js";
import {
  type ConversationRow,
  getDisplayMetaForConversations,
} from "../../memory/conversation-crud.js";
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import {
  countConversations,
  listConversations,
  listPinnedConversations,
} from "../../memory/conversation-queries.js";
import { getBindingsForConversations } from "../../memory/external-conversation-store.js";
import { listGroups } from "../../memory/group-crud.js";
import { UserError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import {
  buildConversationDetailResponse,
  serializeConversationSummary,
} from "../services/conversation-serializer.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversation-list-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOrThrow(rawId: string): string {
  const id = resolveConversationId(rawId);
  if (!id) throw new NotFoundError(`Unknown conversation: ${rawId}`);
  return id;
}

function publishListInvalidated(): void {
  assistantEventHub
    .publish(
      buildAssistantEvent({
        type: "conversation_list_invalidated",
        reason: "seen_changed",
      }),
    )
    .catch((err) => {
      log.warn(
        { err },
        "Failed to publish conversation_list_invalidated (seen_changed)",
      );
    });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListConversations({ queryParams = {} }: RouteHandlerArgs) {
  const limit = Number(queryParams.limit ?? 50);
  const offset = Number(queryParams.offset ?? 0);
  const backgroundOnly = queryParams.conversationType === "background";

  let rows = listConversations(limit, backgroundOnly, offset);
  const totalCount = countConversations(backgroundOnly);

  // On the first page, ensure all pinned conversations are included
  // even if they fall outside the paginated window.
  if (offset === 0 && !backgroundOnly) {
    const pinned = listPinnedConversations();
    const seen = new Set(rows.map((c) => c.id));
    const missing = pinned.filter((c) => !seen.has(c.id));
    if (missing.length > 0) {
      rows = [...rows, ...missing];
    }
  }

  const conversationIds = rows.map((c) => c.id);
  const displayMeta = getDisplayMetaForConversations(conversationIds);
  const bindings = getBindingsForConversations(conversationIds);
  const attentionStates = getAttentionStateByConversationIds(conversationIds);
  const parentCache = new Map<string, ConversationRow | null>();
  const nextOffset = offset + limit;

  const response: Record<string, unknown> = {
    conversations: rows.map((conversation) =>
      serializeConversationSummary({
        conversation,
        binding: bindings.get(conversation.id),
        attentionState: attentionStates.get(conversation.id),
        displayMeta: displayMeta.get(conversation.id),
        parentCache,
      }),
    ),
    nextOffset,
    hasMore: nextOffset < totalCount,
  };

  // Include groups array on first page only
  if (offset === 0) {
    const groups = listGroups();
    response.groups = groups.map((g) => ({
      id: g.id,
      name: g.name,
      sortPosition: g.sortPosition,
      isSystemGroup: g.isSystemGroup,
    }));
  }

  return response;
}

function handleRecordSeen({ body = {} }: RouteHandlerArgs) {
  const rawConversationId = body.conversationId as string | undefined;
  if (!rawConversationId) {
    throw new BadRequestError("Missing conversationId");
  }
  const conversationId = resolveOrThrow(rawConversationId);

  try {
    const priorState = getAttentionStateByConversationIds([conversationId]).get(
      conversationId,
    );
    const wasUnseen =
      priorState != null &&
      priorState.latestAssistantMessageAt != null &&
      (priorState.lastSeenAssistantMessageAt == null ||
        priorState.lastSeenAssistantMessageAt <
          priorState.latestAssistantMessageAt);

    recordConversationSeenSignal({
      conversationId,
      sourceChannel: (body.sourceChannel as string) ?? "vellum",
      signalType: ((body.signalType as string) ??
        "macos_conversation_opened") as SignalType,
      confidence: ((body.confidence as string) ?? "explicit") as Confidence,
      source: (body.source as string) ?? "http-api",
      evidenceText: body.evidenceText as string | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
      observedAt: body.observedAt as number | undefined,
    });

    if (wasUnseen) {
      publishListInvalidated();
    }

    return { ok: true };
  } catch (err) {
    log.error({ err, conversationId }, "POST /v1/conversations/seen: failed");
    throw new InternalError("Failed to record seen signal");
  }
}

function handleMarkUnread({ body = {} }: RouteHandlerArgs) {
  const rawConversationId = body.conversationId as string | undefined;
  if (!rawConversationId) {
    throw new BadRequestError("Missing conversationId");
  }
  const conversationId = resolveOrThrow(rawConversationId);

  try {
    const changed = markConversationUnread(conversationId);
    if (changed) {
      publishListInvalidated();
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof UserError) {
      throw new UnprocessableEntityError(err.message);
    }
    log.error({ err, conversationId }, "POST /v1/conversations/unread: failed");
    throw new InternalError("Failed to mark conversation unread");
  }
}

function handleGetConversation({ pathParams = {} }: RouteHandlerArgs) {
  const detail = buildConversationDetailResponse(pathParams.id!);
  if (!detail) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listConversations",
    endpoint: "conversations",
    method: "GET",
    policyKey: "conversations",
    summary: "List conversations",
    description:
      "Paginated list of conversations with attention state and display metadata.",
    tags: ["conversations"],
    handler: handleListConversations,
  },
  {
    operationId: "recordConversationSeen",
    endpoint: "conversations/seen",
    method: "POST",
    policyKey: "conversations/seen",
    summary: "Record a seen signal",
    description: "Mark a conversation as seen, advancing the attention cursor.",
    tags: ["conversations"],
    handler: handleRecordSeen,
  },
  {
    operationId: "markConversationUnread",
    endpoint: "conversations/unread",
    method: "POST",
    policyKey: "conversations/unread",
    summary: "Mark conversation unread",
    description: "Reset the seen cursor so the conversation appears unread.",
    tags: ["conversations"],
    handler: handleMarkUnread,
  },
  {
    operationId: "getConversation",
    endpoint: "conversations/:id",
    method: "GET",
    pathParams: [{ name: "id", type: "uuid" }],
    summary: "Get conversation detail",
    description: "Retrieve a single conversation with full metadata.",
    tags: ["conversations"],
    handler: handleGetConversation,
  },
];

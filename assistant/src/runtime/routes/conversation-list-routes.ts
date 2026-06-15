/**
 * Route handlers for conversation listing, detail, and seen/unread state.
 *
 * GET    /v1/conversations              — paginated conversation list
 * POST   /v1/conversations/seen         — record a seen signal (single)
 * POST   /v1/conversations/seen/bulk    — record seen signals (batch)
 * POST   /v1/conversations/unread       — mark a conversation unread
 * GET    /v1/conversations/:id          — conversation detail
 */

import { z } from "zod";

import { findConversation } from "../../daemon/conversation-registry.js";
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
import type { ConversationType } from "../../memory/conversation-types.js";
import { getBindingsForConversations } from "../../memory/external-conversation-store.js";
import { listGroups } from "../../memory/group-crud.js";
import { UserError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  buildConversationDetailResponse,
  serializeConversationSummary,
} from "../services/conversation-serializer.js";
import {
  publishConversationListAndMetadataChanged,
  publishConversationListChanged,
} from "../sync/resource-sync-events.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversation-list-routes");

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const channelIdSchema = z.enum([
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "platform",
  "a2a",
]);

const assistantAttentionSchema = z.object({
  hasUnseenLatestAssistantMessage: z.boolean(),
  latestAssistantMessageAt: z.number().optional(),
  lastSeenAssistantMessageAt: z.number().optional(),
  lastSeenConfidence: z.enum(["explicit", "inferred"]).optional(),
  lastSeenSignalType: z
    .enum([
      "macos_notification_view",
      "macos_conversation_opened",
      "ios_conversation_opened",
      "web_bulk_mark_read",
      "telegram_inbound_message",
      "telegram_callback",
      "slack_inbound_message",
      "slack_callback",
    ])
    .optional(),
});

const slackThreadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  link: z
    .object({
      appUrl: z.string().optional(),
      webUrl: z.string().optional(),
    })
    .optional(),
});

const slackChannelSchema = z.object({
  channelId: z.string(),
  name: z.string().optional(),
  link: z.object({ webUrl: z.string() }).optional(),
});

const channelBindingSchema = z.object({
  sourceChannel: z.string(),
  externalChatId: z.string(),
  externalChatName: z.string().optional(),
  externalThreadId: z.string().optional(),
  externalUserId: z.string().nullable(),
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  slackThread: slackThreadSchema.optional(),
  slackChannel: slackChannelSchema.optional(),
});

const forkParentSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  title: z.string(),
});

export const conversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastMessageAt: z.number().nullable(),
  conversationType: z.enum(["standard", "background", "scheduled"]),
  source: z.string(),
  scheduleJobId: z.string().optional(),
  channelBinding: channelBindingSchema.optional(),
  conversationOriginChannel: channelIdSchema.nullable().optional(),
  assistantAttention: assistantAttentionSchema.optional(),
  isPinned: z.literal(true).optional(),
  displayOrder: z.number().nullable().optional(),
  groupId: z.string().nullable(),
  forkParent: forkParentSchema.optional(),
  archivedAt: z.number().optional(),
  /**
   * Epoch-ms timestamp set when a background/scheduled conversation was
   * explicitly promoted ("surfaced") into the Recents sidebar grouping via
   * `POST /v1/conversations/:id/surface`. Absent when not surfaced.
   */
  surfacedAt: z.number().optional(),
  inferenceProfile: z.string().optional(),
  /**
   * True when the agent loop is currently mid-turn for this conversation.
   * Mirrors the in-memory `Conversation.isProcessing()` flag on the daemon
   * — `false` for rows that are cold (not currently resident in memory).
   */
  isProcessing: z.boolean(),
});

const groupSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  sortPosition: z.number(),
  isSystemGroup: z.boolean(),
});

const listConversationsResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  nextOffset: z.number(),
  hasMore: z.boolean(),
  groups: z.array(groupSummarySchema).optional(),
});

const conversationDetailResponseSchema = z.object({
  conversation: conversationSummarySchema,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOrThrow(rawId: string): string {
  const id = resolveConversationId(rawId);
  if (!id) throw new NotFoundError(`Unknown conversation: ${rawId}`);
  return id;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListConversations({ queryParams = {} }: RouteHandlerArgs) {
  const limit = Number(queryParams.limit ?? 50);
  const offset = Number(queryParams.offset ?? 0);
  // "background" is the back-compat umbrella (background + scheduled); newer
  // clients can pass "scheduled" to load only the Scheduled section. Absent
  // defaults to the standard foreground list. Any other value is rejected so
  // an unrecognized type surfaces as a 400 rather than being silently coerced
  // to the foreground list (which would mask client/daemon version skew).
  const rawConversationType = queryParams.conversationType;
  let conversationType: ConversationType = "standard";
  if (rawConversationType !== undefined && rawConversationType !== "") {
    if (
      rawConversationType === "background" ||
      rawConversationType === "scheduled"
    ) {
      conversationType = rawConversationType;
    } else {
      throw new BadRequestError(
        `Unknown conversationType "${rawConversationType}"; expected "background" or "scheduled".`,
      );
    }
  }
  // Defaults to `active` so sidebar restores no longer pull archived rows.
  // The Archive page opts into `archived` to render only archived rows
  // without dragging the entire live history through pagination first.
  const archiveStatus =
    queryParams.archiveStatus === "archived"
      ? "archived"
      : queryParams.archiveStatus === "all"
        ? "all"
        : "active";

  const originChannel =
    queryParams.originChannel !== undefined && queryParams.originChannel !== ""
      ? queryParams.originChannel
      : undefined;

  let rows = listConversations(
    limit,
    conversationType,
    offset,
    archiveStatus,
    originChannel,
  );
  const totalCount = countConversations(
    conversationType,
    archiveStatus,
    originChannel,
  );

  // On the first page, ensure all pinned conversations are included
  // even if they fall outside the paginated window. Pinned injection is
  // skipped in archived/all views since the Archive page renders archived
  // rows in archive-time order, not pin order. Also skipped for
  // channel-scoped queries — those return only items matching the
  // requested origin channel; pinned items render in their own section.
  if (
    offset === 0 &&
    conversationType === "standard" &&
    archiveStatus === "active" &&
    originChannel === undefined
  ) {
    const pinned = listPinnedConversations(archiveStatus);
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
        // Cold (evicted / never-loaded) rows aren't in the in-memory
        // store, so `findConversation` returns `undefined` and they
        // report `isProcessing: false` — by definition they aren't
        // mid-turn since the agent loop only runs on resident convs.
        isProcessing:
          findConversation(conversation.id)?.isProcessing() ?? false,
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

function handleRecordSeen({ body = {}, headers }: RouteHandlerArgs) {
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
      publishConversationListAndMetadataChanged(
        "seen_changed",
        conversationId,
        headers?.["x-vellum-client-id"]?.trim() || undefined,
      );
    }

    return { ok: true };
  } catch (err) {
    log.error({ err, conversationId }, "POST /v1/conversations/seen: failed");
    throw new InternalError("Failed to record seen signal");
  }
}

function handleRecordSeenBulk({ body = {}, headers }: RouteHandlerArgs) {
  const rawIds = body.conversationIds as string[] | undefined;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new BadRequestError("conversationIds must be a non-empty array");
  }

  const originClientId = headers?.["x-vellum-client-id"]?.trim() || undefined;
  const changedIds: string[] = [];

  for (const rawId of rawIds) {
    try {
      const conversationId = resolveOrThrow(rawId);
      const priorState = getAttentionStateByConversationIds([
        conversationId,
      ]).get(conversationId);
      const wasUnseen =
        priorState != null &&
        priorState.latestAssistantMessageAt != null &&
        (priorState.lastSeenAssistantMessageAt == null ||
          priorState.lastSeenAssistantMessageAt <
            priorState.latestAssistantMessageAt);

      recordConversationSeenSignal({
        conversationId,
        sourceChannel: "vellum",
        signalType: "web_bulk_mark_read",
        confidence: "explicit",
        source: "http-api",
      });

      if (wasUnseen) {
        changedIds.push(conversationId);
      }
    } catch (err) {
      log.error(
        { err, conversationId: rawId },
        "POST /v1/conversations/seen/bulk: failed for conversation",
      );
      // Best-effort: continue with remaining conversations.
    }
  }

  if (changedIds.length > 0) {
    publishConversationListChanged("seen_changed", originClientId);
  }

  return { ok: true, updated: changedIds.length };
}

function handleMarkUnread({ body = {}, headers }: RouteHandlerArgs) {
  const rawConversationId = body.conversationId as string | undefined;
  if (!rawConversationId) {
    throw new BadRequestError("Missing conversationId");
  }
  const conversationId = resolveOrThrow(rawConversationId);

  try {
    const changed = markConversationUnread(conversationId);
    if (changed) {
      publishConversationListAndMetadataChanged(
        "seen_changed",
        conversationId,
        headers?.["x-vellum-client-id"]?.trim() || undefined,
      );
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
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List conversations",
    description:
      "Paginated list of conversations with attention state and display metadata.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "limit",
        type: "integer",
        required: false,
        description: "Maximum number of conversations to return (default 50).",
      },
      {
        name: "offset",
        type: "integer",
        required: false,
        description: "Number of conversations to skip (default 0).",
      },
      {
        name: "conversationType",
        type: "string",
        required: false,
        description:
          'Filter by conversation type. Pass "background" to list background and scheduled conversations together (the back-compat umbrella), or "scheduled" to list only scheduled conversations.',
        schema: { type: "string", enum: ["background", "scheduled"] },
      },
      {
        name: "archiveStatus",
        type: "string",
        required: false,
        description:
          'Filter by archive state. Defaults to "active" (non-archived rows only). Pass "archived" to list only archived rows (for the Archive page) or "all" to include both.',
        schema: { type: "string", enum: ["active", "archived", "all"] },
      },
      {
        name: "originChannel",
        type: "string",
        required: false,
        description:
          "Filter by origin channel. When provided, only conversations with this exact origin_channel value are returned. Omit to include all channels.",
        schema: {
          type: "string",
          enum: [
            "slack",
            "telegram",
            "whatsapp",
            "email",
            "a2a",
            "vellum",
            "phone",
          ],
        },
      },
    ],
    responseBody: listConversationsResponseSchema,
    handler: handleListConversations,
  },
  {
    operationId: "recordConversationSeen",
    endpoint: "conversations/seen",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Record a seen signal",
    description: "Mark a conversation as seen, advancing the attention cursor.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string(),
      sourceChannel: z.string().optional(),
      signalType: z.string().optional(),
      confidence: z.enum(["explicit", "inferred"]).optional(),
      source: z.string().optional(),
      evidenceText: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      observedAt: z.number().optional(),
    }),
    responseBody: z.object({ ok: z.boolean() }),
    handler: handleRecordSeen,
  },
  {
    operationId: "recordConversationSeenBulk",
    endpoint: "conversations/seen/bulk",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Bulk mark conversations as seen",
    description:
      "Mark multiple conversations as seen in one request. Emits a single sync invalidation for the entire batch instead of per-conversation events.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationIds: z.array(z.string()).min(1),
    }),
    responseBody: z.object({ ok: z.boolean(), updated: z.number() }),
    handler: handleRecordSeenBulk,
  },
  {
    operationId: "markConversationUnread",
    endpoint: "conversations/unread",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Mark conversation unread",
    description: "Reset the seen cursor so the conversation appears unread.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string(),
    }),
    responseBody: z.object({ ok: z.boolean() }),
    handler: handleMarkUnread,
  },
  {
    operationId: "getConversation",
    endpoint: "conversations/:id",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    pathParams: [{ name: "id", type: "uuid" }],
    summary: "Get conversation detail",
    description: "Retrieve a single conversation with full metadata.",
    tags: ["conversations"],
    responseBody: conversationDetailResponseSchema,
    handler: handleGetConversation,
  },
];

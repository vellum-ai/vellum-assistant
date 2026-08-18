/**
 * Route handlers for conversation listing, detail, and seen/unread state.
 *
 * GET    /v1/conversations              — paginated conversation list
 * GET    /v1/conversations/unread-count - count of unseen foreground conversations
 * GET    /v1/conversations/sections     - per-section totals for the sidebar index
 * POST   /v1/conversations/seen         — record a seen signal (single)
 * POST   /v1/conversations/seen/bulk    — record seen signals (batch)
 * POST   /v1/conversations/unread       — mark a conversation unread
 * GET    /v1/conversations/:id          — conversation detail
 */

import { z } from "zod";

import { CHANNEL_IDS } from "../../channels/types.js";
import { channelBindingSchema } from "../../messaging/channel-binding-schema.js";
import {
  type Confidence,
  getAttentionStateByConversationIds,
  markConversationUnread,
  recordConversationSeenSignal,
  type SignalType,
} from "../../persistence/conversation-attention-store.js";
import { isConversationProcessing } from "../../persistence/conversation-crud.js";
import {
  type ConversationRow,
  getDisplayMetaForConversations,
} from "../../persistence/conversation-crud.js";
import { resolveConversationId } from "../../persistence/conversation-key-store.js";
import {
  type ConversationListFilter,
  countConversations,
  countConversationSections,
  countUnreadConversations,
  listConversations,
  listPinnedConversations,
} from "../../persistence/conversation-queries.js";
import type { ConversationType } from "../../persistence/conversation-types.js";
import { getBindingsForConversations } from "../../persistence/external-conversation-store.js";
import { listGroups } from "../../persistence/group-crud.js";
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

const channelIdSchema = z.enum(CHANNEL_IDS);

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
  /**
   * Present only on a referential fork whose parent conversation was deleted.
   * The fork keeps the messages it owns and the lineage read truncates at the
   * missing parent, so it renders as a conversation that starts mid-thought.
   * Clients surface this so that reads as a deletion rather than as data loss.
   */
  historyOrphaned: z.literal(true).optional(),
  archivedAt: z.number().optional(),
  /**
   * Epoch-ms timestamp set when a background/scheduled conversation was
   * explicitly promoted ("surfaced") into the Recents sidebar grouping via
   * `POST /v1/conversations/:id/surface`. Absent when not surfaced.
   */
  surfacedAt: z.number().optional(),
  inferenceProfile: z.string().optional(),
  /**
   * Plugin-id list scoping this chat to a subset of installed plugins.
   * Absent when there is no per-chat restriction (default: all enabled
   * plugins); an explicit `[]` means the user cleared all optional plugins.
   */
  enabledPlugins: z.array(z.string()).nullable().optional(),
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

const unreadConversationCountResponseSchema = z.object({
  count: z.number(),
});

const sectionCountFields = {
  total: z.number(),
  unread: z.number(),
};

/**
 * One renderable sidebar section. Discriminated by `kind` so clients get a
 * typed union: group sections carry their metadata inline (one consistent
 * snapshot, no join against `GET /v1/groups` that could disagree with it),
 * channel sections carry only the id (labels are client-side i18n), and
 * `chats` is the ungrouped-native bucket. In a view without channel sections
 * the Chats card holds every ungrouped row: the buckets are disjoint, so
 * that reading is `chats` plus the sum of `channel` entries.
 */
const conversationSectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pinned"), ...sectionCountFields }),
  z.object({
    kind: z.literal("group"),
    groupId: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
    sortPosition: z.number(),
    ...sectionCountFields,
  }),
  z.object({
    kind: z.literal("channel"),
    channelId: z.string(),
    ...sectionCountFields,
  }),
  z.object({ kind: z.literal("chats"), ...sectionCountFields }),
]);

const conversationSectionsResponseSchema = z.object({
  sections: z.array(conversationSectionSchema),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOrThrow(rawId: string): string {
  const id = resolveConversationId(rawId);
  if (!id) {
    throw new NotFoundError(`Unknown conversation: ${rawId}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Read a query parameter that admits a closed set of values. Absent or empty
 * reads as `undefined`; anything outside `accepted` is a 400. The strictness
 * is the point: silently coercing a typo or a newer client's value to "no
 * filter" would hand back the full list where a subset was asked for, and
 * that skew is invisible to the client (it masks version skew too).
 */
function parseEnumQueryParam<const T extends readonly string[]>(
  queryParams: Record<string, string | undefined>,
  name: string,
  accepted: T,
): T[number] | undefined {
  const raw = queryParams[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if ((accepted as readonly string[]).includes(raw)) {
    return raw as T[number];
  }
  throw new BadRequestError(
    `Unknown ${name} "${raw}"; expected ${accepted.map((v) => `"${v}"`).join(" or ")}.`,
  );
}

function handleListConversations({ queryParams = {} }: RouteHandlerArgs) {
  const limit = Number(queryParams.limit ?? 50);
  const offset = Number(queryParams.offset ?? 0);
  // "background" is the back-compat umbrella (background + scheduled); newer
  // clients can pass "scheduled" to load only the Scheduled section. Absent
  // defaults to the standard foreground list.
  const conversationType: ConversationType =
    parseEnumQueryParam(queryParams, "conversationType", [
      "background",
      "scheduled",
    ]) ?? "standard";
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

  const groupId =
    queryParams.groupId !== undefined && queryParams.groupId !== ""
      ? queryParams.groupId
      : undefined;

  const needsAttention =
    parseEnumQueryParam(queryParams, "needsAttention", ["true"]) === "true"
      ? true
      : undefined;

  const foregroundOnly =
    parseEnumQueryParam(queryParams, "foregroundOnly", ["true"]) === "true"
      ? true
      : undefined;

  const filter: ConversationListFilter = {
    conversationType,
    archiveStatus,
    originChannel,
    groupId,
    needsAttention,
    foregroundOnly,
  };
  let rows = listConversations({ ...filter, limit, offset });
  const totalCount = countConversations(filter);

  // On the first page, ensure all pinned conversations are included
  // even if they fall outside the paginated window. Pinned injection is
  // skipped in archived/all views since the Archive page renders archived
  // rows in archive-time order, not pin order. Also skipped for
  // channel-scoped queries — those return only items matching the
  // requested origin channel; pinned items render in their own section.
  //
  // Skipped for group-scoped queries for the same reason: a caller asking
  // for one group gets that group, and a client that fetches the Pinned
  // section via `groupId=system:pinned` has no use for rows appended to
  // some other group's page. Skipped for attention-scoped and
  // foreground-only queries too: the caller asked for a subset, and a
  // pinned row outside it appended to the page would sit there while
  // `hasMore` is computed from the filtered count. This is the
  // compatibility shim for clients that still read Pinned out of the
  // unfiltered list; it goes away once every section fetches its own group.
  if (
    offset === 0 &&
    conversationType === "standard" &&
    archiveStatus === "active" &&
    originChannel === undefined &&
    groupId === undefined &&
    needsAttention === undefined &&
    foregroundOnly === undefined
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
        // Checks in-memory flag first (hot path), falls back to the
        // persisted `processing_started_at` column for cold conversations.
        isProcessing: isConversationProcessing(conversation.id),
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

function handleGetUnreadConversationCount() {
  return { count: countUnreadConversations() };
}

/**
 * One row per non-empty sidebar section, no conversation rows. What this
 * exists to answer without a list drain: which sections render at all,
 * and what their rail badges say.
 *
 * A count row whose `group_id` names no existing non-system group is
 * skipped rather than surfaced: those rows are unreachable as a section
 * (the sidebar builds group sections from the groups table), and a
 * dangling id is a transient state around group deletion, not a section.
 */
function handleGetConversationSections() {
  const counts = countConversationSections();
  const groupsById = new Map(listGroups().map((g) => [g.id, g]));
  const sections: Array<z.infer<typeof conversationSectionSchema>> = [];

  for (const row of counts.groups) {
    if (row.groupId === "system:pinned") {
      sections.push({ kind: "pinned", total: row.total, unread: row.unread });
      continue;
    }
    const meta = groupsById.get(row.groupId);
    if (!meta || meta.isSystemGroup) {
      continue;
    }
    sections.push({
      kind: "group",
      groupId: row.groupId,
      name: meta.name,
      icon: meta.icon,
      sortPosition: meta.sortPosition,
      total: row.total,
      unread: row.unread,
    });
  }

  for (const row of counts.channels) {
    if (row.channel === "vellum") {
      sections.push({ kind: "chats", total: row.total, unread: row.unread });
      continue;
    }
    sections.push({
      kind: "channel",
      channelId: row.channel,
      total: row.total,
      unread: row.unread,
    });
  }

  /* Every other section exists only when it has rows; Chats is the leftover
     bucket and renders regardless, so its counts are part of the contract
     even at zero. */
  if (!sections.some((s) => s.kind === "chats")) {
    sections.push({ kind: "chats", total: 0, unread: 0 });
  }

  return { sections };
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
          enum: [...CHANNEL_IDS],
        },
      },
      {
        name: "groupId",
        type: "string",
        required: false,
        description:
          'Filter to a single group, so each sidebar section can load independently of the paginated list. Pass "system:all" for conversations in no group, "system:pinned" for the Pinned section, or a custom group id. A group-scoped request is recency-ordered like every list read (COALESCE(last_message_at, updated_at) descending) and never has pinned rows appended to it. Omit to span every group.',
      },
      {
        name: "needsAttention",
        type: "string",
        required: false,
        description:
          'Pass "true" to return only conversations whose latest assistant message the user has not seen: the same predicate behind the unread count and the section index, so a client that keeps no complete conversation list can ask for exactly the rows its attention surfaces need. Composes with every other filter. Any value other than "true" is rejected. Omit to span every conversation.',
        schema: { type: "string", enum: ["true"] },
      },
      {
        name: "foregroundOnly",
        type: "string",
        required: false,
        description:
          'Pass "true" to return only user-facing foreground conversations, dropping the automated background and scheduled runs the standard listing admits when they are filed in a custom group (a surfaced run stays). This is the same predicate the unread count and the section index apply, so a client can ask for the newest conversation a user can open in one row instead of paging past runs it would skip. Composes with every other filter; a foreground-only first page never has pinned rows appended to it. Any value other than "true" is rejected. Omit to keep every visible row.',
        schema: { type: "string", enum: ["true"] },
      },
    ],
    responseBody: listConversationsResponseSchema,
    handler: handleListConversations,
  },
  {
    operationId: "getUnreadConversationCount",
    endpoint: "conversations/unread-count",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Unread conversation count",
    description:
      "Count of foreground conversations whose latest assistant message is unseen. Matches the sidebar's unread indicators: archived rows and non-surfaced background/scheduled rows are excluded.",
    tags: ["conversations"],
    responseBody: unreadConversationCountResponseSchema,
    handler: handleGetUnreadConversationCount,
  },
  {
    operationId: "getConversationSections",
    endpoint: "conversations/sections",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Sidebar section index",
    description:
      "One row per renderable sidebar section (Pinned, each non-empty custom group, each origin channel with unassigned conversations, Chats) with total and unread counts and no conversation rows. Lets a client know which sections exist, and what their badges say, without fetching any conversation list. Totals follow the standard listing visibility; unread applies the same rules as GET /v1/conversations/unread-count scoped to the section. Chats is always present, even at zero: it is the leftover bucket and renders regardless.",
    tags: ["conversations"],
    responseBody: conversationSectionsResponseSchema,
    handler: handleGetConversationSections,
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
    description:
      "Retrieve a single conversation with full metadata. Rows the listing hides by type (legacy private rows) are not found here either.",
    tags: ["conversations"],
    responseBody: conversationDetailResponseSchema,
    handler: handleGetConversation,
  },
];

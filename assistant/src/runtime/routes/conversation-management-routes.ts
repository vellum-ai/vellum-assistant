/**
 * Route handlers for conversation management operations.
 *
 * POST   /v1/conversations                 — create a new conversation
 * POST   /v1/conversations/switch         — switch to an existing conversation
 * POST   /v1/conversations/fork           — fork an existing conversation
 * PUT    /v1/conversations/:id/inference-profile — set per-conversation inference profile
 * PUT    /v1/conversations/:id/enabledplugins — set per-conversation plugin scope
 * PATCH  /v1/conversations/:id/name       — rename a conversation
 * DELETE /v1/conversations                 — clear all conversations
 * POST   /v1/conversations/:id/wipe       — wipe conversation and revert memory
 * DELETE /v1/conversations/:id            — delete a single conversation
 * POST   /v1/conversations/:id/archive    — archive a conversation
 * POST   /v1/conversations/:id/unarchive  — restore an archived conversation
 * POST   /v1/conversations/archive/bulk   — archive multiple conversations
 * POST   /v1/conversations/:id/surface    — promote to / demote from Recents
 * POST   /v1/conversations/:id/cancel     — cancel generation
 * POST   /v1/conversations/:id/undo       — undo last message
 * POST   /v1/conversations/reorder        — reorder / pin conversations
 */

import { z } from "zod";

import { findConversation } from "../../daemon/conversation-registry.js";
import { destroyActiveConversation } from "../../daemon/conversation-store.js";
import {
  cancelGeneration,
  clearAllConversations,
  resolveMetaSlashCommand,
  switchConversation,
  undoLastMessage,
} from "../../daemon/handlers/conversations.js";
import { normalizeConversationType } from "../../daemon/message-types/shared.js";
import { stripConversationIds } from "../../home/feed-writer.js";
import {
  archiveConversation,
  batchSetDisplayOrders,
  countConversationsByScheduleJobId,
  deleteConversation,
  forkConversation as forkConversationInStore,
  getConversation,
  setConversationEnabledPlugins,
  setConversationSurfaced,
  unarchiveConversation,
  updateConversationTitle,
  wipeConversation,
} from "../../persistence/conversation-crud.js";
import {
  getOrCreateConversation,
  resolveConversationId,
  setConversationKeyIfAbsent,
} from "../../persistence/conversation-key-store.js";
import { enqueueMemoryJob } from "../../persistence/jobs-store.js";
import { deleteSchedule } from "../../schedule/schedule-store.js";
import { UserError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { buildConversationDetailResponse } from "../services/conversation-serializer.js";
import {
  publishConversationEnabledPluginsChanged,
  publishConversationListAndMetadataChanged,
  publishConversationListChanged,
  publishConversationTitleChanged,
} from "../sync/resource-sync-events.js";
import { conversationSummarySchema } from "./conversation-list-routes.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import { setInferenceProfileSession } from "./inference-profile-session-handler.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversation-management-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOrThrow(rawId: string): string {
  const id = resolveConversationId(rawId);
  if (!id) throw new NotFoundError(`Conversation ${rawId} not found`);
  return id;
}

async function cancelScheduleIfLast(conversationId: string): Promise<void> {
  const conv = getConversation(conversationId);
  if (
    conv?.scheduleJobId &&
    countConversationsByScheduleJobId(conv.scheduleJobId) <= 1
  ) {
    await deleteSchedule(conv.scheduleJobId);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleCreateConversation({ body = {}, headers }: RouteHandlerArgs) {
  const conversationKey =
    (body.conversationKey as string | undefined) ?? crypto.randomUUID();
  // The shared route adapter does not runtime-validate the body against the
  // Zod requestBody (it's codegen-only), so guard the type before trimming —
  // a malformed `{ title: 123 }` would otherwise throw on `.trim()` and 500.
  if (body.title !== undefined && typeof body.title !== "string") {
    throw new BadRequestError("title must be a string");
  }
  const customTitle = body.title?.trim() || undefined;
  const result = getOrCreateConversation(conversationKey, {
    conversationType: "standard",
  });
  if (result.created) {
    // A caller-supplied title is user-set: persist it with isAutoTitle = 0 so
    // the async LLM titler's safe-overwrite check leaves it untouched. Without
    // one, fall back to the neutral "New Conversation" placeholder, which stays
    // replaceable by the auto-titler once messages arrive.
    if (customTitle) {
      updateConversationTitle(result.conversationId, customTitle, 0);
    } else {
      updateConversationTitle(result.conversationId, "New Conversation");
    }
    publishConversationListAndMetadataChanged(
      "created",
      result.conversationId,
      headers?.["x-vellum-client-id"]?.trim() || undefined,
    );
  }
  log.info(
    {
      conversationId: result.conversationId,
      conversationKey,
      created: result.created,
    },
    "Created conversation via POST",
  );
  return {
    id: result.conversationId,
    conversationKey,
    conversationType: normalizeConversationType(result.conversationType),
    created: result.created,
  };
}

async function handleForkConversation({
  body = {},
  headers,
}: RouteHandlerArgs) {
  const conversationId = body.conversationId as string | undefined;
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("Missing conversationId");
  }
  if (
    body.throughMessageId !== undefined &&
    typeof body.throughMessageId !== "string"
  ) {
    throw new BadRequestError("throughMessageId must be a string");
  }

  const resolvedConversationId =
    resolveConversationId(conversationId) ?? conversationId;

  try {
    const forkedConversation = forkConversationInStore({
      conversationId: resolvedConversationId,
      throughMessageId: body.throughMessageId as string | undefined,
    });
    const detail = buildConversationDetailResponse(forkedConversation.id);
    if (!detail) {
      throw new InternalError(
        `Forked conversation ${forkedConversation.id} could not be loaded`,
      );
    }
    publishConversationListAndMetadataChanged(
      "created",
      forkedConversation.id,
      headers?.["x-vellum-client-id"]?.trim() || undefined,
    );
    return { conversation: detail.conversation };
  } catch (err) {
    if (err instanceof UserError) {
      throw new NotFoundError(err.message);
    }
    throw err;
  }
}

async function handleSwitchConversation({ body = {} }: RouteHandlerArgs) {
  const conversationId = body.conversationId as string | undefined;
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("Missing conversationId");
  }
  const result = await switchConversation(conversationId);
  if (!result) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }
  if (body.conversationKey && typeof body.conversationKey === "string") {
    setConversationKeyIfAbsent(body.conversationKey, conversationId);
  }
  return {
    conversationId: result.conversationId,
    title: result.title,
    conversationType: normalizeConversationType(result.conversationType),
    ...(result.inferenceProfile != null
      ? { inferenceProfile: result.inferenceProfile }
      : {}),
  };
}

async function handleSetInferenceProfile({
  pathParams = {},
  body = {},
  headers,
}: RouteHandlerArgs) {
  if (
    body.profile !== null &&
    (typeof body.profile !== "string" || (body.profile as string).length === 0)
  ) {
    throw new BadRequestError("profile must be a non-empty string or null");
  }

  const result = await setInferenceProfileSession({
    conversationId: pathParams.id!,
    profile: body.profile as string | null,
    ttlSeconds: body.ttlSeconds as number | null | undefined,
    sessionId: body.sessionId as string | undefined,
    originClientId: headers?.["x-vellum-client-id"]?.trim() || undefined,
  });

  return result;
}

async function handleUpdateConversationEnabledPlugins({
  pathParams = {},
  body = {},
  headers,
}: RouteHandlerArgs) {
  const enabledPlugins = body.enabledPlugins as string[] | null | undefined;
  if (
    enabledPlugins != null &&
    (!Array.isArray(enabledPlugins) ||
      enabledPlugins.some((p) => typeof p !== "string"))
  ) {
    throw new BadRequestError(
      "enabledPlugins must be an array of strings or null",
    );
  }

  const resolvedId = resolveConversationId(pathParams.id!) ?? pathParams.id!;
  const conversation = getConversation(resolvedId);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }

  // `null` clears the per-chat scope back to the default (all enabled
  // plugins); a `string[]` scopes the chat to those plugin ids.
  const nextEnabledPlugins = enabledPlugins ?? null;
  setConversationEnabledPlugins(resolvedId, nextEnabledPlugins);
  findConversation(resolvedId)?.setEnabledPlugins(nextEnabledPlugins);

  publishConversationEnabledPluginsChanged(
    resolvedId,
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );

  return { conversationId: resolvedId, enabledPlugins: nextEnabledPlugins };
}

function handleRenameConversation({
  pathParams = {},
  body = {},
  headers,
}: RouteHandlerArgs) {
  const name = body.name as string | undefined;
  if (!name || typeof name !== "string") {
    throw new BadRequestError("Missing name");
  }
  const conversation = getConversation(pathParams.id!);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  updateConversationTitle(pathParams.id!, name, 0);

  publishConversationTitleChanged(
    pathParams.id!,
    name,
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );

  return { ok: true };
}

async function handleClearAllConversations({ headers = {} }: RouteHandlerArgs) {
  const confirm = headers["x-confirm-destructive"];
  if (confirm !== "clear-all-conversations") {
    throw new BadRequestError(
      "DELETE /v1/conversations permanently deletes ALL conversations, messages, and memory. " +
        "To confirm, set header X-Confirm-Destructive: clear-all-conversations",
    );
  }
  await clearAllConversations();
  publishConversationListChanged(
    "deleted",
    headers["x-vellum-client-id"]?.trim() || undefined,
  );
  return undefined;
}

async function handleWipeConversation({
  pathParams = {},
  headers,
}: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);

  await cancelScheduleIfLast(resolvedId);

  destroyActiveConversation(resolvedId);
  const result = wipeConversation(resolvedId);
  for (const segId of result.segmentIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "segment",
      targetId: segId,
    });
  }
  for (const summaryId of result.deletedSummaryIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "summary",
      targetId: summaryId,
    });
  }
  log.info(
    {
      conversationId: resolvedId,
      summariesDeleted: result.deletedSummaryIds.length,
      jobsCancelled: result.cancelledJobCount,
    },
    "Wiped conversation and reverted memory changes",
  );
  publishConversationListAndMetadataChanged(
    "deleted",
    resolvedId,
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );

  void stripConversationIds(resolvedId);

  return {
    wiped: true,
    unsupersededItems: 0,
    deletedSummaries: result.deletedSummaryIds.length,
    cancelledJobs: result.cancelledJobCount,
  };
}

async function handleDeleteConversation({
  pathParams = {},
  headers,
}: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);

  await cancelScheduleIfLast(resolvedId);

  destroyActiveConversation(resolvedId);
  const deleted = deleteConversation(resolvedId);
  for (const segId of deleted.segmentIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "segment",
      targetId: segId,
    });
  }
  for (const summaryId of deleted.deletedSummaryIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "summary",
      targetId: summaryId,
    });
  }
  // The lexical-index purge is fired by `deleteConversation` itself (via the
  // `onConversationDeleted` persistence hook), so every delete caller cleans up
  // — no route-level purge needed here.
  log.info({ conversationId: resolvedId }, "Deleted conversation");

  publishConversationListAndMetadataChanged(
    "deleted",
    resolvedId,
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );

  void stripConversationIds(resolvedId);

  return undefined;
}

function handleArchiveConversation({
  pathParams = {},
  headers,
}: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);
  const archived = archiveConversation(resolvedId);
  if (!archived) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  publishConversationListAndMetadataChanged(
    "reordered",
    resolvedId,
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );
  return { ok: true, conversationId: resolvedId };
}

function handleUnarchiveConversation({
  pathParams = {},
  headers,
}: RouteHandlerArgs) {
  const resolvedId = resolveOrThrow(pathParams.id!);
  const unarchived = unarchiveConversation(resolvedId);
  if (!unarchived) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  publishConversationListAndMetadataChanged(
    "reordered",
    resolvedId,
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );
  return { ok: true, conversationId: resolvedId };
}

function handleArchiveConversationsBulk({
  body = {},
  headers,
}: RouteHandlerArgs) {
  const rawIds = body.conversationIds as string[] | undefined;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new BadRequestError("conversationIds must be a non-empty array");
  }

  const originClientId = headers?.["x-vellum-client-id"]?.trim() || undefined;
  const archivedIds: string[] = [];

  for (const rawId of rawIds) {
    try {
      const conversationId = resolveOrThrow(rawId);
      const archived = archiveConversation(conversationId);
      if (archived) {
        archivedIds.push(conversationId);
      }
    } catch (err) {
      log.error(
        { err, conversationId: rawId },
        "POST /v1/conversations/archive/bulk: failed for conversation",
      );
      // Best-effort: continue with remaining conversations.
    }
  }

  if (archivedIds.length > 0) {
    publishConversationListChanged("reordered", originClientId);
  }

  return { ok: true, archived: archivedIds.length };
}

/**
 * Set or clear the `surfacedAt` promotion marker on a conversation.
 *
 * Surfacing is the explicit opt-in that makes a background/scheduled
 * conversation appear in the default conversation listing (and therefore the
 * Recents sidebar grouping). It is never set automatically — product flows
 * call this when a background conversation deserves foreground visibility
 * (e.g. the user sent a follow-up message in it).
 */
function handleSurfaceConversation({
  pathParams = {},
  body = {},
  headers,
}: RouteHandlerArgs) {
  if (typeof body.surfaced !== "boolean") {
    throw new BadRequestError("Missing surfaced boolean");
  }
  const resolvedId = resolveOrThrow(pathParams.id!);
  const result = setConversationSurfaced(resolvedId, body.surfaced);
  if (!result) {
    throw new NotFoundError(`Conversation ${pathParams.id} not found`);
  }
  // Shape-changing for the default list (row appears in / disappears from
  // the standard listing), so publish with a shape-changing reason — web
  // refetches the paginated list, macOS gets the legacy typed broadcast.
  publishConversationListAndMetadataChanged(
    "reordered",
    resolvedId,
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );
  return {
    ok: true,
    conversationId: resolvedId,
    surfacedAt: result.surfacedAt,
  };
}

function handleCancelGeneration({ pathParams = {} }: RouteHandlerArgs) {
  const resolvedId = resolveConversationId(pathParams.id!) ?? pathParams.id!;
  const cancelled = cancelGeneration(resolvedId);
  return { ok: true, cancelled, conversationId: resolvedId };
}

async function handleUndoLastMessage({ pathParams = {} }: RouteHandlerArgs) {
  const result = await undoLastMessage(pathParams.id!);
  if (!result) {
    throw new NotFoundError(`No active conversation for ${pathParams.id}`);
  }
  return {
    removedCount: result.removedCount,
    conversationId: pathParams.id!,
  };
}

async function handleResolveMetaSlashCommand({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const command = body.command as string | undefined;
  if (!command || typeof command !== "string") {
    throw new BadRequestError("Missing command");
  }
  let result: Awaited<ReturnType<typeof resolveMetaSlashCommand>>;
  try {
    result = await resolveMetaSlashCommand(pathParams.id!, command);
  } catch (err) {
    if (err instanceof UserError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
  if (!result) {
    throw new NotFoundError(`No conversation for ${pathParams.id}`);
  }
  return result;
}

function handleReorderConversations({ body = {}, headers }: RouteHandlerArgs) {
  const updates = body.updates as
    | Array<{
        conversationId: string;
        displayOrder?: number;
        isPinned?: boolean;
        groupId?: string | null;
      }>
    | undefined;
  if (!Array.isArray(updates)) {
    throw new BadRequestError("Missing updates array");
  }
  batchSetDisplayOrders(
    updates.map((u) => ({
      id: u.conversationId,
      displayOrder: u.displayOrder ?? null,
      isPinned: u.isPinned,
      groupId: u.groupId,
    })),
  );
  publishConversationListAndMetadataChanged(
    "reordered",
    updates.map((u) => u.conversationId),
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "createConversation",
    endpoint: "conversations",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a conversation",
    description: "Create or get an existing conversation by key.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationKey: z
        .string()
        .optional()
        .describe(
          "Optional external key. Echoed back in the response. Non-vellum channels (Telegram, WhatsApp) use this to scope to a logical channel thread; vellum-web clients can omit it and rely on the assistant-minted `id`.",
        ),
      conversationType: z
        .literal("standard")
        .optional()
        .describe("Only standard conversations are created by this endpoint"),
      title: z
        .string()
        .optional()
        .describe(
          "Explicit title for the conversation. When provided on creation, it is persisted as a user-set title (never overwritten by the auto-titler). Used by flows that mint a conversation up-front and don't want an auto-generated title.",
        ),
    }),
    responseBody: z.object({
      id: z
        .string()
        .describe(
          "Assistant-minted internal conversation id. The authoritative identifier for the conversation.",
        ),
      conversationKey: z
        .string()
        .describe("Echo of the optional external key supplied by the client."),
      conversationType: z.string(),
      created: z.boolean(),
    }),
    handler: handleCreateConversation,
  },
  {
    operationId: "forkConversation",
    endpoint: "conversations/fork",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Fork a conversation",
    description:
      "Create a copy of a conversation, optionally truncated at a specific message.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string(),
      throughMessageId: z
        .string()
        .describe("Truncate the fork at this message")
        .optional(),
    }),
    responseBody: z.object({
      conversation: conversationSummarySchema,
    }),
    handler: handleForkConversation,
  },
  {
    operationId: "switchConversation",
    endpoint: "conversations/switch",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Switch active conversation",
    description: "Set the active conversation for the current session.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string(),
      conversationKey: z
        .string()
        .describe("Optional key to register for this conversation")
        .optional(),
    }),
    responseBody: z.object({
      conversationId: z.string(),
      title: z.string(),
      conversationType: z.string(),
      inferenceProfile: z.string().optional(),
    }),
    handler: handleSwitchConversation,
  },
  {
    operationId: "setConversationInferenceProfile",
    endpoint: "conversations/:id/inference-profile",
    method: "PUT",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set conversation inference profile",
    description:
      "Override the LLM inference profile for a single conversation. " +
      "Optionally supply ttlSeconds to create a session-backed (expiring) override.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      profile: z.string().nullable(),
      ttlSeconds: z.number().positive().nullable().optional(),
      sessionId: z.string().uuid().optional(),
    }),
    responseBody: z.object({
      conversationId: z.string(),
      profile: z.string().nullable(),
      sessionId: z.string().nullable(),
      expiresAt: z.number().nullable(),
      ttlSeconds: z.number().nullable().optional(),
      replaced: z
        .object({
          profile: z.string().nullable(),
          sessionId: z.string().nullable(),
          expiresAt: z.number().nullable(),
        })
        .nullable(),
    }),
    handler: handleSetInferenceProfile,
  },
  {
    operationId: "conversations_by_id_enabledplugins_put",
    endpoint: "conversations/:id/enabledplugins",
    method: "PUT",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set conversation enabled plugins",
    description:
      "Scope a single conversation to a subset of installed plugins " +
      "(first-party defaults are always available). Pass null to clear the " +
      "scope back to the default (all enabled plugins).",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      enabledPlugins: z.array(z.string()).nullable(),
    }),
    responseBody: z.object({
      conversationId: z.string(),
      enabledPlugins: z.array(z.string()).nullable(),
    }),
    handler: handleUpdateConversationEnabledPlugins,
  },
  {
    operationId: "renameConversation",
    endpoint: "conversations/:id/name",
    method: "PATCH",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Rename a conversation",
    description: "Update the display name of a conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      name: z.string(),
    }),
    responseBody: z.object({ ok: z.boolean() }),
    handler: handleRenameConversation,
  },
  {
    operationId: "clearAllConversations",
    endpoint: "conversations",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Clear all conversations",
    description: "Permanently delete ALL conversations, messages, and memory.",
    tags: ["conversations"],
    responseStatus: "204",
    handler: handleClearAllConversations,
  },
  {
    operationId: "wipeConversation",
    endpoint: "conversations/:id/wipe",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Wipe a conversation",
    description:
      "Delete all messages in a conversation and revert associated memory changes.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      wiped: z.boolean(),
      unsupersededItems: z.number().int(),
      deletedSummaries: z.number().int(),
      cancelledJobs: z.number().int(),
    }),
    handler: handleWipeConversation,
  },
  {
    operationId: "deleteConversation",
    endpoint: "conversations/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a conversation",
    description: "Permanently delete a single conversation and its messages.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseStatus: "204",
    handler: handleDeleteConversation,
  },
  {
    operationId: "archiveConversation",
    endpoint: "conversations/:id/archive",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Archive a conversation",
    description: "Move a conversation to the archived state.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      ok: z.boolean(),
      conversationId: z.string(),
    }),
    handler: handleArchiveConversation,
  },
  {
    operationId: "unarchiveConversation",
    endpoint: "conversations/:id/unarchive",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Unarchive a conversation",
    description:
      "Restore an archived conversation back to the default sidebar.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      ok: z.boolean(),
      conversationId: z.string(),
    }),
    handler: handleUnarchiveConversation,
  },
  {
    operationId: "archiveConversationsBulk",
    endpoint: "conversations/archive/bulk",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Bulk archive conversations",
    description:
      "Archive multiple conversations in one request. Emits a single sync invalidation for the entire batch.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationIds: z.array(z.string()).min(1),
    }),
    responseBody: z.object({ ok: z.boolean(), archived: z.number() }),
    handler: handleArchiveConversationsBulk,
  },
  {
    operationId: "surfaceConversation",
    endpoint: "conversations/:id/surface",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Surface a conversation into Recents",
    description:
      "Explicitly promote a background or scheduled conversation into the " +
      "default conversation listing (the Recents sidebar grouping), or demote " +
      "it with surfaced=false. Conversations are never surfaced automatically.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      surfaced: z
        .boolean()
        .describe(
          "true to surface the conversation into Recents, false to clear the promotion.",
        ),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      conversationId: z.string(),
      surfacedAt: z
        .number()
        .nullable()
        .describe("Epoch-ms timestamp of the promotion, or null when cleared."),
    }),
    handler: handleSurfaceConversation,
  },
  {
    operationId: "cancelConversationGeneration",
    endpoint: "conversations/:id/cancel",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Cancel generation",
    description: "Abort the in-progress assistant response for a conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id" }],
    responseStatus: "202",
    responseBody: z.object({
      ok: z.boolean(),
      cancelled: z.boolean(),
      conversationId: z.string(),
    }),
    handler: handleCancelGeneration,
  },
  {
    operationId: "undoLastMessage",
    endpoint: "conversations/:id/undo",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Undo last message",
    description:
      "Remove the most recent user+assistant message pair from the conversation.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      removedCount: z.number().int(),
      conversationId: z.string(),
    }),
    handler: handleUndoLastMessage,
  },
  {
    operationId: "resolveConversationSlashCommand",
    endpoint: "conversations/:id/slash",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Resolve a local meta slash command",
    description:
      "Run a local meta slash command (/clean, /status, /commands, /models) " +
      "without starting a turn: no messages are persisted and no turn events " +
      "are emitted. /clean also strips runtime injections from the history. " +
      "Returns the text to render and, for /clean, the post-strip context usage.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      command: z
        .string()
        .describe("The slash command text, e.g. `/clean` or `/status`."),
    }),
    responseBody: z.object({
      kind: z.enum(["clean", "info"]),
      text: z.string(),
      contextUsage: z
        .object({
          tokens: z.number(),
          maxTokens: z.number().nullable(),
          fillRatio: z.number().nullable(),
        })
        .optional(),
    }),
    handler: handleResolveMetaSlashCommand,
  },
  {
    operationId: "reorderConversations",
    endpoint: "conversations/reorder",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Reorder conversations",
    description: "Batch-update display order and pin state for conversations.",
    tags: ["conversations"],
    requestBody: z.object({
      updates: z.array(
        z.object({
          conversationId: z.string(),
          displayOrder: z.number().optional(),
          isPinned: z.boolean().optional(),
          groupId: z.string().nullable().optional(),
        }),
      ),
    }),
    responseBody: z.object({ ok: z.boolean() }),
    handler: handleReorderConversations,
  },
];

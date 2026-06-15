import { mkdirSync, rmSync } from "node:fs";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { z } from "zod";

import type { ChannelId, InterfaceId } from "../channels/types.js";
import { parseChannelId, parseInterfaceId } from "../channels/types.js";
import { CHANNEL_IDS, isChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { findDisplayTurnEndIndex } from "../conversations/message-consolidation.js";
import { conversationMetadataSyncTag } from "../daemon/message-types/sync.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { clearAllConversationIds } from "../home/feed-writer.js";
import {
  forkEverInjected,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  seedEverInjectedFromSlugs,
} from "../plugins/defaults/memory-v3-shadow/ever-injected-store.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { UserError } from "../util/errors.js";
import { safeParseRecord } from "../util/json.js";
import { getLogger } from "../util/logger.js";
import { getConversationsDir } from "../util/platform.js";
import { createRowMapper } from "../util/row-mapper.js";
import {
  deleteOrphanAttachments,
  linkAttachmentToMessage,
} from "./attachments-store.js";
import { AUTO_ANALYSIS_SOURCE } from "./auto-analysis-constants.js";
import {
  projectAssistantMessage,
  seedForkedConversationAttention,
} from "./conversation-attention-store.js";
import {
  initConversationDir,
  removeConversationDir,
  syncMessageToDisk,
  updateMetaFile,
} from "./conversation-disk-view.js";
import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { ensureGroupMigration } from "./conversation-group-migration.js";
import { runAsyncSqlite } from "./db-async-query.js";
import { getDb, getSqliteFrom } from "./db-connection.js";
import { forkGraphMemoryState } from "./graph/graph-memory-state-store.js";
import { indexMessageNow } from "./indexer.js";
import { MEMORY_RETROSPECTIVE_SOURCES } from "./memory-retrospective-constants.js";
import { forkRetrospectiveState } from "./memory-retrospective-state.js";
import { rawExec, rawGet, rawRun } from "./raw-query.js";
import {
  channelInboundEvents,
  conversations,
  llmRequestLogs,
  memoryEmbeddings,
  memorySegments,
  memorySummaries,
  messageAttachments,
  messages,
  skillLoadedEvents,
  toolInvocations,
} from "./schema.js";
import { cancelPendingJobsForConversation } from "./task-memory-cleanup.js";
import {
  forkActivationState,
  seedForkActivationState,
} from "./v2/activation-store.js";
import { extractInjectedConceptSlugs } from "./v2/injected-block-slugs.js";

const log = getLogger("conversation-store");

// ── Message metadata Zod schema ──────────────────────────────────────
// Validates the JSON stored in messages.metadata. Known fields are typed;
// extra keys are allowed via passthrough so callers can attach ad-hoc data.

const channelIdSchema = z.enum(CHANNEL_IDS);
// Accept both canonical INTERFACE_IDS and the legacy "vellum" alias,
// normalizing to "web" on read so downstream code only handles canonical IDs.
const interfaceIdSchema = z
  .string()
  .transform((v) => parseInterfaceId(v))
  .refine((v): v is InterfaceId => v !== null);

const subagentNotificationSchema = z.object({
  subagentId: z.string(),
  label: z.string(),
  status: z.enum(["running", "completed", "failed", "aborted"]),
  error: z.string().optional(),
  conversationId: z.string().optional(),
  objective: z.string().optional(),
});

export const messageMetadataSchema = z
  .object({
    userMessageChannel: channelIdSchema.optional(),
    assistantMessageChannel: channelIdSchema.optional(),
    userMessageInterface: interfaceIdSchema.optional(),
    assistantMessageInterface: interfaceIdSchema.optional(),
    /**
     * Optional client-side metadata bag attached to user messages by HTTP
     * header middleware (reads `x-vellum-browser-family`,
     * `x-vellum-browser-version`, `x-vellum-client-os`,
     * `x-vellum-interface-version`). Forwarded verbatim onto
     * `TurnTelemetryEvent.client` for downstream analytics. Kept as a
     * permissive `record` so adding a new client field doesn't require a
     * migration -- dbt can unpack later via JSON_VALUE.
     */
    client: z.record(z.string(), z.unknown()).optional(),
    subagentNotification: subagentNotificationSchema.optional(),
    /**
     * Trust class of the actor at the time this message was persisted.
     * This is a durable snapshot -- it does NOT change if the actor's
     * trust status changes later. Used by the memory write gate (indexer)
     * and read gate (conversation history loading) to enforce trust-aware access.
     */
    provenanceTrustClass: z
      .enum(["guardian", "trusted_contact", "unknown"])
      .optional(),
    provenanceSourceChannel: channelIdSchema.optional(),
    provenanceGuardianExternalUserId: z.string().optional(),
    provenanceRequesterIdentifier: z.string().optional(),
    automated: z.boolean().optional(),
    forkSourceMessageId: z.string().optional(),
    /** Image source paths from desktop attachments, keyed by filename. */
    imageSourcePaths: z.record(z.string(), z.string()).optional(),
    memoryInjectedBlock: z.string().optional(),
    /** Memory-v3 frozen net-new card block (unwrapped) — the v3 counterpart
     *  of `memoryInjectedBlock`. A row carries at most one of the two. */
    [MEMORY_V3_INJECTED_BLOCK_METADATA_KEY]: z.string().optional(),
    turnContextBlock: z.string().optional(),
    pkbSystemReminderBlock: z.string().optional(),
    workspaceBlock: z.string().optional(),
    nowScratchpadBlock: z.string().optional(),
    pkbContextBlock: z.string().optional(),
    memoryV2StaticBlock: z.string().optional(),
  })
  .passthrough();

function cloneForkMessageMetadata(
  metadata: string | null,
  sourceMessageId: string,
): string {
  if (!metadata) {
    return JSON.stringify({ forkSourceMessageId: sourceMessageId });
  }

  try {
    const parsed = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sourceRecord = parsed as Record<string, unknown>;
      const forkSourceMessageId =
        typeof sourceRecord.forkSourceMessageId === "string"
          ? sourceRecord.forkSourceMessageId
          : sourceMessageId;
      return JSON.stringify({
        ...sourceRecord,
        forkSourceMessageId,
      });
    }
  } catch {
    // Fall through to source-only metadata.
  }

  return JSON.stringify({ forkSourceMessageId: sourceMessageId });
}

/**
 * Read a persisted memory-injection block off a message's metadata JSON, or
 * `null` when absent/malformed. `key` selects the injection layer: v2's
 * `memoryInjectedBlock` or memory-v3's card block
 * (`MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`). The block is what the request
 * builder re-attaches as the message's `<memory>` content each turn.
 */
function readInjectedBlock(
  metadata: string | null,
  key: string,
): string | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const block = (parsed as Record<string, unknown>)[key];
      if (typeof block === "string") return block;
    }
  } catch {
    // Malformed metadata — treat as no block.
  }
  return null;
}

/**
 * Extract provenance metadata fields from a TrustContext.
 * When no guardian context is provided, defaults to 'unknown' because the
 * absence of trust context means we cannot verify trust —
 * callers with actual guardian trust should always supply a real context.
 */
export function provenanceFromTrustContext(
  ctx: TrustContext | null | undefined,
): Record<string, unknown> {
  if (!ctx) return { provenanceTrustClass: "unknown" };
  return {
    provenanceTrustClass: ctx.trustClass,
    provenanceSourceChannel: ctx.sourceChannel,
    provenanceGuardianExternalUserId: ctx.guardianExternalUserId,
    provenanceRequesterIdentifier: ctx.requesterIdentifier,
  };
}

/** Extract image file paths from resolved attachments for message metadata. */
export function extractImageSourcePaths(
  attachments: ReadonlyArray<{
    filename: string;
    mimeType: string;
    filePath?: string;
  }>,
): Record<string, string> | undefined {
  const paths: Record<string, string> = {};
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
      paths[`${i}:${a.filename}`] = a.filePath;
    }
  }
  return Object.keys(paths).length > 0 ? paths : undefined;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  contextSummary: string | null;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  historyStrippedAt: number | null;
  slackContextCompactionWatermarkTs: string | null;
  slackContextCompactionWatermarkAt: number | null;
  conversationType: string;
  source: string;
  memoryScopeId: string;
  originChannel: string | null;
  originInterface: string | null;
  forkParentConversationId: string | null;
  forkParentMessageId: string | null;
  isAutoTitle: number;
  scheduleJobId: string | null;
  lastMessageAt: number | null;
  archivedAt: number | null;
  surfacedAt: number | null;
  inferenceProfile: string | null;
  inferenceProfileSessionId: string | null;
  inferenceProfileExpiresAt: number | null;
  lastNotifiedInferenceProfile: string | null;
}

export const parseConversation = createRowMapper<
  typeof conversations.$inferSelect,
  ConversationRow
>({
  id: "id",
  title: "title",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  totalInputTokens: "totalInputTokens",
  totalOutputTokens: "totalOutputTokens",
  totalEstimatedCost: "totalEstimatedCost",
  contextSummary: "contextSummary",
  contextCompactedMessageCount: "contextCompactedMessageCount",
  contextCompactedAt: "contextCompactedAt",
  historyStrippedAt: "historyStrippedAt",
  slackContextCompactionWatermarkTs: "slackContextCompactionWatermarkTs",
  slackContextCompactionWatermarkAt: "slackContextCompactionWatermarkAt",
  conversationType: "conversationType",
  source: "source",
  memoryScopeId: "memoryScopeId",
  originChannel: "originChannel",
  originInterface: "originInterface",
  forkParentConversationId: "forkParentConversationId",
  forkParentMessageId: "forkParentMessageId",
  isAutoTitle: "isAutoTitle",
  scheduleJobId: "scheduleJobId",
  lastMessageAt: "lastMessageAt",
  archivedAt: "archivedAt",
  surfacedAt: "surfacedAt",
  inferenceProfile: "inferenceProfile",
  inferenceProfileSessionId: "inferenceProfileSessionId",
  inferenceProfileExpiresAt: "inferenceProfileExpiresAt",
  lastNotifiedInferenceProfile: "lastNotifiedInferenceProfile",
});

/** Allowed values for the `role` column on `messages`. */
export type MessageRole = "user" | "assistant" | "system";

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
  clientMessageId: string | null;
}

const parseMessage = createRowMapper<typeof messages.$inferSelect, MessageRow>({
  id: "id",
  conversationId: "conversationId",
  role: "role",
  content: "content",
  createdAt: "createdAt",
  metadata: "metadata",
  clientMessageId: "clientMessageId",
});

export type ConversationCreateType = "standard" | "background" | "scheduled";

/**
 * Monotonic timestamp source for message ordering. Two messages saved within
 * the same millisecond (e.g., tool_results user message + assistant message in
 * message_complete) would get the same Date.now(), making their reload order
 * non-deterministic. This counter ensures every call returns a strictly
 * increasing value so insertion order is always preserved.
 */
let lastTimestamp = 0;
function monotonicNow(): number {
  const now = Date.now();
  lastTimestamp = Math.max(now, lastTimestamp + 1);
  return lastTimestamp;
}

// ── insertMessageCore ─────────────────────────────────────────────────

/** Shape returned by {@link insertMessageCore} and its public wrappers. */
interface InsertedMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  metadata?: string;
  clientMessageId?: string;
  deduplicated: boolean;
}

interface InsertMessageCoreParams {
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
  clientMessageId?: string;
}

/**
 * Core message persistence primitive shared by {@link addMessage} and
 * {@link reserveMessage}.
 *
 * Inserts a message row inside a transaction that atomically bumps the
 * parent conversation's `updatedAt` / `lastMessageAt` timestamps and
 * conditionally sets the conversation's `originChannel` when the first
 * channel-originated message arrives.
 *
 * When a `clientMessageId` is provided the insert runs inside a
 * SAVEPOINT. If the partial unique index on
 * `(conversation_id, client_message_id)` raises
 * `SQLITE_CONSTRAINT_UNIQUE`, the SAVEPOINT is rolled back, the
 * existing row is fetched, and returned with `deduplicated: true`.
 * This makes the operation idempotent for client-generated
 * correlation nonces.
 *
 * Retries up to 3 times on `SQLITE_BUSY*` / `SQLITE_IOERR*` to handle
 * WAL contention. The timestamp is recomputed each attempt so a late
 * retry doesn't persist a stale `updatedAt`.
 */
async function insertMessageCore(
  params: InsertMessageCoreParams,
): Promise<InsertedMessage> {
  const { conversationId, role, content, metadata, clientMessageId } = params;
  const db = getDb();
  const messageId = uuid();

  if (metadata) {
    const result = messageMetadataSchema.safeParse(metadata);
    if (!result.success) {
      log.warn(
        { conversationId, messageId, issues: result.error.issues },
        "Invalid message metadata, storing as-is",
      );
    }
  }

  const metadataStr = metadata ? JSON.stringify(metadata) : undefined;
  const originChannelCandidate =
    metadata && isChannelId(metadata.userMessageChannel)
      ? metadata.userMessageChannel
      : null;

  const MAX_RETRIES = 3;
  let now!: number;
  for (let attempt = 0; ; attempt++) {
    now = monotonicNow();
    try {
      const values = {
        id: messageId,
        conversationId,
        role,
        content,
        createdAt: now,
        ...(metadataStr ? { metadata: metadataStr } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      };

      if (clientMessageId) {
        // Idempotent insert: skip silently if this clientMessageId was
        // already persisted for the conversation.
        const raw = getSqliteFrom(db);
        raw.exec("SAVEPOINT insert_msg");
        try {
          db.insert(messages).values(values).run();
          if (originChannelCandidate) {
            db.update(conversations)
              .set({ originChannel: originChannelCandidate })
              .where(
                and(
                  eq(conversations.id, conversationId),
                  isNull(conversations.originChannel),
                ),
              )
              .run();
          }
          db.update(conversations)
            .set({ updatedAt: now, lastMessageAt: now })
            .where(eq(conversations.id, conversationId))
            .run();
          raw.exec("RELEASE insert_msg");
        } catch (insertErr) {
          raw.exec("ROLLBACK TO insert_msg");
          raw.exec("RELEASE insert_msg");
          const code = (insertErr as { code?: string }).code ?? "";
          if (code === "SQLITE_CONSTRAINT_UNIQUE") {
            // Duplicate clientMessageId — return the existing row.
            const existing = db
              .select()
              .from(messages)
              .where(
                and(
                  eq(messages.conversationId, conversationId),
                  eq(messages.clientMessageId, clientMessageId),
                ),
              )
              .get();
            if (existing) {
              return {
                id: existing.id,
                conversationId: existing.conversationId,
                role: existing.role as MessageRole,
                content: existing.content,
                createdAt: existing.createdAt,
                ...(existing.metadata ? { metadata: existing.metadata } : {}),
                clientMessageId: existing.clientMessageId ?? undefined,
                deduplicated: true,
              };
            }
          }
          throw insertErr;
        }
      } else {
        // No clientMessageId — standard insert inside a transaction.
        db.transaction((tx) => {
          tx.insert(messages).values(values).run();
          if (originChannelCandidate) {
            tx.update(conversations)
              .set({ originChannel: originChannelCandidate })
              .where(
                and(
                  eq(conversations.id, conversationId),
                  isNull(conversations.originChannel),
                ),
              )
              .run();
          }
          tx.update(conversations)
            .set({ updatedAt: now, lastMessageAt: now })
            .where(eq(conversations.id, conversationId))
            .run();
        });
      }
      break;
    } catch (err) {
      const errCode = (err as { code?: string }).code ?? "";
      if (
        attempt < MAX_RETRIES &&
        (errCode.startsWith("SQLITE_BUSY") ||
          errCode.startsWith("SQLITE_IOERR"))
      ) {
        log.warn(
          { attempt, conversationId, code: errCode },
          "insertMessageCore: transient SQLite error, retrying",
        );
        await Bun.sleep(50 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  return {
    id: messageId,
    conversationId,
    role,
    content,
    createdAt: now,
    ...(metadataStr ? { metadata: metadataStr } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    deduplicated: false,
  };
}

export function createConversation(
  titleOrOpts?:
    | string
    | {
        title?: string;
        /**
         * Override the `is_auto_title` column (schema default 1). Pass
         * `AUTO_TITLE_DETERMINISTIC` (2) when the title was derived
         * deterministically at bootstrap so later generation passes know
         * they may replace it.
         */
        isAutoTitle?: number;
        conversationType?: ConversationCreateType;
        source?: string;
        scheduleJobId?: string;
        groupId?: string;
        forkParentConversationId?: string;
      },
) {
  const db = getDb();
  const now = Date.now();
  const opts =
    typeof titleOrOpts === "string"
      ? { title: titleOrOpts }
      : (titleOrOpts ?? {});
  const requestedConversationType = opts.conversationType;
  const conversationType: ConversationCreateType =
    requestedConversationType ?? "standard";
  const source = opts.source ?? "user";
  const groupId = opts.groupId;
  const id = uuid();
  const memoryScopeId = "default";

  // Ensure group_id column exists for deterministic schema readiness,
  // even when this conversation has no groupId (a subsequent query or
  // reorder may reference the column).
  ensureGroupMigration();

  const conversation = {
    id,
    title: opts.title ?? null,
    ...(opts.isAutoTitle !== undefined
      ? { isAutoTitle: opts.isAutoTitle }
      : {}),
    createdAt: now,
    updatedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null as string | null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null as number | null,
    slackContextCompactionWatermarkTs: null as string | null,
    slackContextCompactionWatermarkAt: null as number | null,
    conversationType,
    source,
    memoryScopeId,
    scheduleJobId: opts.scheduleJobId ?? null,
    forkParentConversationId: opts.forkParentConversationId ?? null,
  };

  // Retry on SQLITE_BUSY and SQLITE_IOERR — transient disk I/O errors or WAL
  // contention can cause the first attempt to fail even under normal load.
  // INSERT and group_id UPDATE are retried independently so a transient failure
  // on the UPDATE doesn't re-execute the already-succeeded INSERT (which would
  // hit a unique constraint violation).
  // No explicit BEGIN/COMMIT here — callers that need atomicity (e.g.
  // forkConversation) wrap in their own transaction, and nesting raw BEGIN
  // inside Drizzle's db.transaction() would crash SQLite.
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      db.insert(conversations).values(conversation).run();
      break;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (
        attempt < MAX_RETRIES &&
        (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR"))
      ) {
        log.warn(
          { attempt, conversationId: id, code },
          "createConversation: INSERT transient error, retrying",
        );
        Bun.sleepSync(50 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  // group_id is NOT in the Drizzle schema (raw-query-only pattern).
  // Set via raw SQL after the INSERT succeeds.
  // Always set group_id — default to "system:all" when none provided.
  {
    const effectiveGroupId = groupId ?? "system:all";
    for (let attempt = 0; ; attempt++) {
      try {
        rawRun(
          "UPDATE conversations SET group_id = ?, is_pinned = ? WHERE id = ?",
          effectiveGroupId,
          effectiveGroupId === "system:pinned" ? 1 : 0,
          id,
        );
        break;
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        if (
          attempt < MAX_RETRIES &&
          (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR"))
        ) {
          log.warn(
            { attempt, conversationId: id, code },
            "createConversation: group_id UPDATE transient error, retrying",
          );
          Bun.sleepSync(50 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  initConversationDir({ ...conversation, originChannel: null });

  return conversation;
}

export function getConversation(id: string): ConversationRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return row ? parseConversation(row) : null;
}

/**
 * Count conversations that reference a given schedule job ID.
 * Useful for determining whether a schedule can be safely deleted
 * (i.e. no other conversations still reference it).
 */
export function countConversationsByScheduleJobId(
  scheduleJobId: string,
): number {
  return (
    rawGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM conversations WHERE schedule_job_id = ?",
      scheduleJobId,
    )?.c ?? 0
  );
}

/**
 * Find the rolling analysis conversation for a given source conversation,
 * or null if none exists yet. Used by the auto-analyze loop to append
 * to an existing analysis conversation rather than creating a new one
 * each time the analyze job fires.
 *
 * Returns the most recently updated match if multiple exist (defensive —
 * shouldn't happen in normal operation but the contract is well-defined).
 *
 * Hits `idx_conversations_fork_parent_conversation_id` for the
 * `forkParentConversationId` lookup.
 */
export function findAnalysisConversationFor(
  parentConversationId: string,
): { id: string } | null {
  const db = getDb();
  const row = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.source, AUTO_ANALYSIS_SOURCE),
        eq(conversations.forkParentConversationId, parentConversationId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  return row ? { id: row.id } : null;
}

/**
 * Find the most recent memory-retrospective background conversation rooted
 * at `parentConversationId`. Used by the memory-retrospective job handler
 * to load the prior retrospective's `remember` calls into the new run's
 * `<already_remembered>` block — bounded source-of-truth for "what the
 * prior pass already saved" that scales as the source conversation grows.
 *
 * Walks up `forkParentConversationId` when no retrospective exists at the
 * current level. This lets a forked conversation inherit dedup context from
 * its source's most recent retro on the fork's *first* retrospective —
 * otherwise the fork would re-save every fact the source already retro'd.
 * Once the fork accumulates its own retros, those are found at the first
 * iteration and we never walk up.
 *
 * The returned `forkParentConversationId` is the conversation the
 * retrospective row is rooted at — `parentConversationId` itself when it has
 * its own retros, or an ancestor when the chain walk found the row higher
 * up. Callers that mutate the prior (e.g. GC of superseded runs) must check
 * it against the source conversation: an ancestor's row is that ancestor's
 * dedup baseline, not the caller's to delete.
 *
 * Returns `null` when no prior retrospective exists anywhere in the fork
 * chain (true first-run case).
 *
 * Hits `idx_conversations_fork_parent_conversation_id` for the
 * `forkParentConversationId` lookup.
 */
const MAX_FORK_CHAIN_DEPTH = 16;

export function findMostRecentRetrospectiveFor(
  parentConversationId: string,
): { id: string; forkParentConversationId: string } | null {
  const db = getDb();
  let currentId: string | null = parentConversationId;
  for (let depth = 0; depth < MAX_FORK_CHAIN_DEPTH && currentId; depth++) {
    const row = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          inArray(conversations.source, MEMORY_RETROSPECTIVE_SOURCES),
          eq(conversations.forkParentConversationId, currentId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1)
      .get();
    if (row) return { id: row.id, forkParentConversationId: currentId };

    const parent = db
      .select({
        forkParentConversationId: conversations.forkParentConversationId,
      })
      .from(conversations)
      .where(eq(conversations.id, currentId))
      .get();
    currentId = parent?.forkParentConversationId ?? null;
  }
  return null;
}

/**
 * Returns the `source` column for the given conversation, or null if
 * not found. Tiny convenience used by the recursion guard in the
 * auto-analyze loop.
 */
export function getConversationSource(conversationId: string): string | null {
  const db = getDb();
  const row = db
    .select({ source: conversations.source })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.source ?? null;
}

/**
 * Fetch group_id for a conversation via raw SQL. group_id is NOT in the
 * Drizzle schema (raw-query-only pattern), so ConversationRow doesn't
 * include it. This helper is used by forkConversation to inherit group_id.
 */
function getConversationGroupId(conversationId: string): string | null {
  ensureGroupMigration();
  const row = rawGet<{ group_id: string | null }>(
    "SELECT group_id FROM conversations WHERE id = ?",
    conversationId,
  );
  return row?.group_id ?? null;
}

export function forkConversation(params: {
  conversationId: string;
  throughMessageId?: string;
  /**
   * Override the fork's `source` column. Defaults to the standard
   * `createConversation` default (`"user"`). Used by fork-based memory
   * retrospectives to mark the fork as a retrospective artifact distinct
   * from a user-initiated fork, so dedup and cleanup queries can scope
   * correctly.
   */
  source?: string;
  /**
   * Optional title for the fork. Defaults to `<parent title> (Fork)`.
   */
  title?: string;
  /**
   * Override the fork's `conversationType` column. Defaults to `"standard"`.
   * Used by fork-based memory retrospectives to bucket the fork as a
   * `"background"` conversation so it doesn't surface in the user's
   * conversation list.
   */
  conversationType?: ConversationCreateType;
  /**
   * Override the fork's `groupId`. Defaults to the parent conversation's
   * group (or `"system:all"` when the parent has none). Used by fork-based
   * memory retrospectives to route the fork into a dedicated background
   * group.
   */
  groupId?: string;
}): ConversationRow {
  const { conversationId, throughMessageId } = params;
  const db = getDb();
  const sourceConversation = getConversation(conversationId);

  if (!sourceConversation) {
    throw new UserError(`Conversation ${conversationId} not found`);
  }
  const sourceMessages = getMessages(conversationId);
  if (throughMessageId != null) {
    // `getMessages` orders by `createdAt` only; when rows share an identical
    // millisecond timestamp the tie order is unspecified. Callers that pin the
    // fork to a cutoff choose it from a `(createdAt, id)` cursor (e.g. the
    // memory-retrospective job, via `getMessagesAfter`), so slicing through
    // `throughMessageId` under the unstable order could include same-timestamp
    // siblings the cursor considers *after* the cutoff (reprocessed next run)
    // or exclude ones it considers *before* it (skipped forever). Re-sort on
    // `(createdAt, id)` so the slice agrees with the cutoff. The unpinned full
    // fork copies every row regardless of order, so it keeps source order.
    sourceMessages.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }

  if (sourceMessages.length === 0) {
    throw new UserError(
      `Conversation ${conversationId} has no persisted messages to fork`,
    );
  }

  const initialBoundaryIndex =
    throughMessageId == null
      ? sourceMessages.length - 1
      : sourceMessages.findIndex((message) => message.id === throughMessageId);

  if (throughMessageId != null && initialBoundaryIndex === -1) {
    throw new UserError(
      `Message ${throughMessageId} does not belong to conversation ${conversationId}`,
    );
  }

  // Extend the boundary to cover the full display turn the client
  // addressed. The read-path collapses each assistant turn across
  // multiple DB rows — consecutive assistant rows AND tool-result-only
  // user rows between them — so "fork through message X" semantically
  // means "fork through the entire display turn containing X" no matter
  // which DB row in the cluster the client supplied. Single source of
  // truth is `findDisplayTurnEndIndex`, shared with the read path so
  // both stay in sync.
  const copyBoundaryIndex = findDisplayTurnEndIndex(
    sourceMessages,
    initialBoundaryIndex,
  );

  const visibleWindowStartIndex = Math.max(
    0,
    Math.min(
      sourceConversation.contextCompactedMessageCount,
      sourceMessages.length,
    ),
  );
  const preserveSourceCompactionState =
    copyBoundaryIndex >= visibleWindowStartIndex;

  const messagesToCopy =
    copyBoundaryIndex >= 0
      ? sourceMessages.slice(0, copyBoundaryIndex + 1)
      : ([] as MessageRow[]);

  // Inherit the history-strip marker only when the fork boundary is at-or-
  // after the strip event. Pre-strip forks branch from history that pre-
  // dates the strip, so the marker would be a no-op and is misleading to
  // copy.
  const sourceHistoryStrippedAt = sourceConversation.historyStrippedAt ?? null;
  const boundaryMessageCreatedAt = messagesToCopy.at(-1)?.createdAt ?? null;
  const inheritsHistoryStrippedAt =
    sourceHistoryStrippedAt != null &&
    boundaryMessageCreatedAt != null &&
    boundaryMessageCreatedAt >= sourceHistoryStrippedAt;
  const forkParentMessageId = messagesToCopy.at(-1)?.id ?? null;
  const forkTitle =
    params.title ?? `${sourceConversation.title ?? "Untitled"} (Fork)`;

  // Collect disk-sync work to run after the transaction commits.
  const diskSyncQueue: Array<{
    conversationId: string;
    messageId: string;
    createdAt: number;
  }> = [];

  // Wrap all DB mutations in a single transaction so a mid-flight failure
  // rolls back cleanly instead of leaving a partial fork. Helper functions
  // (linkAttachmentToMessage, relinkAttachments, seedForkedConversationAttention)
  // use the same underlying bun:sqlite connection, so their writes participate
  // in this transaction automatically.
  // Inherit group_id from parent via raw SQL helper (group_id is not in Drizzle schema)
  const parentGroupId = getConversationGroupId(conversationId);

  const forkedConversation = db.transaction(() => {
    const fc = createConversation({
      title: forkTitle,
      conversationType: params.conversationType ?? "standard",
      groupId: params.groupId ?? parentGroupId ?? "system:all",
      ...(params.source != null ? { source: params.source } : {}),
    });

    db.update(conversations)
      .set({
        forkParentConversationId: sourceConversation.id,
        forkParentMessageId,
        contextSummary: preserveSourceCompactionState
          ? sourceConversation.contextSummary
          : null,
        contextCompactedMessageCount: preserveSourceCompactionState
          ? sourceConversation.contextCompactedMessageCount
          : 0,
        contextCompactedAt: preserveSourceCompactionState
          ? sourceConversation.contextCompactedAt
          : null,
        slackContextCompactionWatermarkTs: preserveSourceCompactionState
          ? sourceConversation.slackContextCompactionWatermarkTs
          : null,
        slackContextCompactionWatermarkAt: preserveSourceCompactionState
          ? sourceConversation.slackContextCompactionWatermarkAt
          : null,
        historyStrippedAt: inheritsHistoryStrippedAt
          ? sourceHistoryStrippedAt
          : null,
        inferenceProfile: sourceConversation.inferenceProfile,
      })
      .where(eq(conversations.id, fc.id))
      .run();

    const forkedMessageIds = new Map<string, string>();
    let latestForkedAssistant: {
      messageId: string;
      messageAt: number;
    } | null = null;

    for (const message of messagesToCopy) {
      const forkedMessageId = uuid();
      db.insert(messages)
        .values({
          id: forkedMessageId,
          conversationId: fc.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          metadata: cloneForkMessageMetadata(message.metadata, message.id),
        })
        .run();
      forkedMessageIds.set(message.id, forkedMessageId);

      if (message.role === "assistant") {
        latestForkedAssistant = {
          messageId: forkedMessageId,
          messageAt: message.createdAt,
        };
      }
    }

    const attachmentIdMap = new Map<string, string>();
    for (const message of messagesToCopy) {
      const forkedMessageId = forkedMessageIds.get(message.id);
      if (!forkedMessageId) continue;

      const attachmentLinks = db
        .select({
          attachmentId: messageAttachments.attachmentId,
          position: messageAttachments.position,
        })
        .from(messageAttachments)
        .where(eq(messageAttachments.messageId, message.id))
        .orderBy(messageAttachments.position)
        .all();
      const uncachedAttachmentLinks = attachmentLinks.filter(
        (link) => !attachmentIdMap.has(link.attachmentId),
      );
      const stagingMessageId =
        uncachedAttachmentLinks.length > 0 ? uuid() : null;

      if (stagingMessageId) {
        db.insert(messages)
          .values({
            id: stagingMessageId,
            conversationId: fc.id,
            role: message.role,
            content: "",
            createdAt: message.createdAt,
            metadata: null,
          })
          .run();
      }

      for (const link of attachmentLinks) {
        const cachedAttachmentId = attachmentIdMap.get(link.attachmentId);
        if (cachedAttachmentId) {
          db.insert(messageAttachments)
            .values({
              id: uuid(),
              messageId: forkedMessageId,
              attachmentId: cachedAttachmentId,
              position: link.position,
              createdAt: Date.now(),
            })
            .run();
          continue;
        }

        const scopedAttachmentId = linkAttachmentToMessage(
          stagingMessageId ?? forkedMessageId,
          link.attachmentId,
          link.position,
        );
        attachmentIdMap.set(link.attachmentId, scopedAttachmentId);
      }

      if (stagingMessageId) {
        relinkAttachments([stagingMessageId], forkedMessageId);
        db.delete(messages).where(eq(messages.id, stagingMessageId)).run();
      }

      diskSyncQueue.push({
        conversationId: fc.id,
        messageId: forkedMessageId,
        createdAt: fc.createdAt,
      });
    }

    // Set lastMessageAt to the max createdAt of copied messages so the
    // forked conversation sorts correctly by message recency.
    const lastCopiedMessage = messagesToCopy.at(-1);
    if (lastCopiedMessage) {
      db.update(conversations)
        .set({ lastMessageAt: lastCopiedMessage.createdAt })
        .where(eq(conversations.id, fc.id))
        .run();
    }

    seedForkedConversationAttention({
      conversationId: fc.id,
      latestAssistantMessageId: latestForkedAssistant?.messageId ?? null,
      latestAssistantMessageAt: latestForkedAssistant?.messageAt ?? null,
    });

    // Carry the parent's per-conversation memory state into the child so the
    // forked thread resumes with the same activation/injection log and
    // in-context tracker the parent had at fork time. Only valid for
    // full-history forks: a truncated fork would inherit activation/tracker
    // entries for turns the child does not actually contain.
    const isFullHistoryFork = copyBoundaryIndex === sourceMessages.length - 1;
    if (isFullHistoryFork) {
      forkActivationState(db, sourceConversation.id, fc.id);
      forkEverInjected(db, sourceConversation.id, fc.id);
      forkGraphMemoryState(sourceConversation.id, fc.id);
    } else {
      // Truncated fork: the wholesale copy above would over-claim, but
      // seeding nothing makes the child re-select and re-attach every page
      // whose `<memory>` attachment it already inherited (observed in
      // production: 89 duplicate page injections on one fork). Derive
      // `everInjected` from the inherited attachments themselves — scoped to
      // the child's visible window, since attachments behind an inherited
      // compaction boundary are not rendered and must stay re-injectable.
      // The v2 and v3 layers persist under separate metadata keys with the
      // same `# memory/concepts/<slug>.md` header convention, so each seeds
      // its own dedup record from its own blocks.
      const visibleStartIndex = preserveSourceCompactionState
        ? visibleWindowStartIndex
        : 0;
      const inheritedSlugs = new Set<string>();
      const inheritedV3Slugs = new Set<string>();
      for (const message of messagesToCopy.slice(visibleStartIndex)) {
        const block = readInjectedBlock(
          message.metadata,
          "memoryInjectedBlock",
        );
        if (block) {
          for (const slug of extractInjectedConceptSlugs(block)) {
            inheritedSlugs.add(slug);
          }
        }
        const v3Block = readInjectedBlock(
          message.metadata,
          MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
        );
        if (v3Block) {
          for (const slug of extractInjectedConceptSlugs(v3Block)) {
            inheritedV3Slugs.add(slug);
          }
        }
      }
      seedForkActivationState(db, fc.id, [...inheritedSlugs]);
      seedEverInjectedFromSlugs(
        db,
        sourceConversation.id,
        fc.id,
        [...inheritedV3Slugs],
        Date.now(),
      );
    }
    forkRetrospectiveState({
      database: db,
      sourceConversationId: sourceConversation.id,
      forkedConversationId: fc.id,
      forkedMessageIds,
      lastCopiedSourceMessageId: messagesToCopy.at(-1)?.id ?? null,
    });

    return fc;
  });

  // Disk-view sync runs after commit — file I/O is idempotent and
  // conversation deletion cleans up orphaned directories.
  for (const entry of diskSyncQueue) {
    syncMessageToDisk(entry.conversationId, entry.messageId, entry.createdAt);
  }

  const persistedFork = getConversation(forkedConversation.id);
  if (!persistedFork) {
    throw new Error(
      `Failed to load forked conversation ${forkedConversation.id} after creation`,
    );
  }

  return persistedFork;
}

/**
 * Delete a conversation and all its messages, cleaning up orphaned memory
 * artifacts (embeddings). Returns segment IDs so callers can clean up
 * the corresponding Qdrant vector entries.
 */
export function deleteConversation(id: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = {
    segmentIds: [],
    deletedSummaryIds: [],
  };

  // Capture createdAt before the transaction deletes the row — needed to
  // resolve the conversation's disk-view directory path after deletion.
  const convBeforeDelete = getConversation(id);
  const createdAtForDiskCleanup = convBeforeDelete?.createdAt;

  db.transaction((tx) => {
    // Collect all message IDs for this conversation.
    const messageRows = tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .all();
    const messageIds = messageRows.map((r) => r.id);

    if (messageIds.length > 0) {
      // Collect memory segment IDs linked to these messages before cascade.
      const linkedSegments = tx
        .select({ id: memorySegments.id })
        .from(memorySegments)
        .where(inArray(memorySegments.messageId, messageIds))
        .all();
      result.segmentIds = linkedSegments.map((r) => r.id);

      // Delete non-cascading tables first.
      tx.delete(llmRequestLogs)
        .where(eq(llmRequestLogs.conversationId, id))
        .run();
      tx.delete(toolInvocations)
        .where(eq(toolInvocations.conversationId, id))
        .run();
      tx.delete(skillLoadedEvents)
        .where(eq(skillLoadedEvents.conversationId, id))
        .run();
      // Cascade deletes memory_segments, message_attachments.
      tx.delete(messages).where(eq(messages.conversationId, id)).run();

      // Clean up segment embeddings.
      if (result.segmentIds.length > 0) {
        tx.delete(memoryEmbeddings)
          .where(
            and(
              eq(memoryEmbeddings.targetType, "segment"),
              inArray(memoryEmbeddings.targetId, result.segmentIds),
            ),
          )
          .run();
      }
    } else {
      // No messages — just clean up non-message tables.
      tx.delete(llmRequestLogs)
        .where(eq(llmRequestLogs.conversationId, id))
        .run();
      tx.delete(toolInvocations)
        .where(eq(toolInvocations.conversationId, id))
        .run();
      tx.delete(skillLoadedEvents)
        .where(eq(skillLoadedEvents.conversationId, id))
        .run();
    }

    tx.delete(conversations).where(eq(conversations.id, id)).run();
  });

  // Remove the conversation's disk-view directory after the DB transaction
  if (createdAtForDiskCleanup != null) {
    removeConversationDir(id, createdAtForDiskCleanup);
  }

  return result;
}

/**
 * Wipe a conversation and revert all memory changes it caused.
 *
 * Extends `deleteConversation` with:
 * - Cancelling pending memory jobs before deletion
 * - Deleting conversation-scoped memory summaries and their embeddings
 */
export function wipeConversation(id: string): WipeConversationResult {
  const db = getDb();
  const deletedSummaryIds: string[] = [];

  // Step A — Cancel pending memory jobs (before deleting messages, since
  // the cancellation queries join on `messages`).
  const cancelledJobCount = cancelPendingJobsForConversation(id);

  // Step C — Delete conversation-scoped memory summaries and their embeddings.
  const summaryRows = db
    .select({ id: memorySummaries.id })
    .from(memorySummaries)
    .where(
      and(
        eq(memorySummaries.scope, "conversation"),
        eq(memorySummaries.scopeKey, id),
      ),
    )
    .all();
  const summaryIds = summaryRows.map((r) => r.id);
  if (summaryIds.length > 0) {
    db.delete(memoryEmbeddings)
      .where(
        and(
          eq(memoryEmbeddings.targetType, "summary"),
          inArray(memoryEmbeddings.targetId, summaryIds),
        ),
      )
      .run();
    db.delete(memorySummaries)
      .where(inArray(memorySummaries.id, summaryIds))
      .run();
  }
  deletedSummaryIds.push(...summaryIds);

  // Step D — Delegate to deleteConversation which handles messages (cascade
  // segments, attachments), llmRequestLogs, toolInvocations,
  // skillLoadedEvents, embeddings, and the conversation row.
  const deletedMemoryIds = deleteConversation(id);

  // Step E — Return the combined result.
  return {
    ...deletedMemoryIds,
    deletedSummaryIds: [
      ...deletedSummaryIds,
      ...deletedMemoryIds.deletedSummaryIds,
    ],
    cancelledJobCount,
  };
}

/** Options for {@link addMessage}. Only `skipIndexing` and `clientMessageId`
 *  have defaults; `metadata` is genuinely optional. */
export interface AddMessageOptions {
  metadata?: Record<string, unknown>;
  skipIndexing?: boolean;
  /** Client-generated nonce for idempotent inserts. When provided,
   *  duplicate inserts for the same `(conversationId, clientMessageId)`
   *  pair are silently skipped. */
  clientMessageId?: string;
}

/**
 * Persist a message and run post-insert side effects (memory indexing,
 * attention projection). Delegates the core insert + retry logic to
 * {@link insertMessageCore}.
 */
export async function addMessage(
  conversationId: string,
  role: MessageRole,
  content: string,
  options?: AddMessageOptions,
) {
  const { metadata, skipIndexing, clientMessageId } = options ?? {};
  const inserted = await insertMessageCore({
    conversationId,
    role,
    content,
    metadata,
    clientMessageId,
  });

  if (inserted.deduplicated) {
    return inserted;
  }

  const message = inserted;

  if (!skipIndexing) {
    try {
      const config = getConfig();
      const parsed = metadata
        ? messageMetadataSchema.safeParse(metadata)
        : null;
      const provenanceTrustClass = parsed?.success
        ? parsed.data.provenanceTrustClass
        : undefined;
      const automated = parsed?.success ? parsed.data.automated : undefined;
      await indexMessageNow(
        {
          messageId: message.id,
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          scopeId: "default",
          provenanceTrustClass,
          automated,
        },
        config.memory,
      );
    } catch (err) {
      log.warn(
        { err, conversationId, messageId: message.id },
        "Failed to index message for memory",
      );
    }
  }

  if (role === "assistant") {
    try {
      const attentionStateChanged = projectAssistantMessage({
        conversationId,
        messageId: message.id,
        messageAt: message.createdAt,
      });
      if (attentionStateChanged) {
        void publishSyncInvalidation([
          conversationMetadataSyncTag(conversationId),
        ]);
      }
    } catch (err) {
      log.warn(
        { err, conversationId, messageId: message.id },
        "Failed to project assistant message for attention tracking",
      );
    }
  }

  return message;
}

export function getMessages(conversationId: string): MessageRow[] {
  const db = getDb();
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(parseMessage);
}

/**
 * Return raw `metadata` strings for messages whose metadata looks like it may
 * contain Slack metadata, capped at `limit` and skipping the first `offset`
 * matches. Pushes `LIKE` + `LIMIT`/`OFFSET` into SQL so warm Slack DM
 * conversations don't require a full-table scan on the webhook critical path.
 * The substring match is an indexable prefilter only — callers must parse and
 * validate each returned string against the Slack metadata schema, because a
 * malformed row (partial write, legacy format, unrelated key accidentally
 * containing the literal) can still slip through the substring match. Callers
 * that need a fixed number of *valid* rows should iterate with increasing
 * offsets until the target is reached (capped at a reasonable maximum to bound
 * scan cost).
 */
export function selectSlackMetaCandidateMetadata(
  conversationId: string,
  limit: number,
  offset = 0,
  opts?: { includeFlatLegacy?: boolean },
): string[] {
  const db = getDb();
  const rows = db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        opts?.includeFlatLegacy
          ? or(
              like(messages.metadata, '%"slackMeta"%'),
              like(messages.metadata, '%"source":"slack"%'),
            )
          : like(messages.metadata, '%"slackMeta"%'),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r.metadata === "string" && r.metadata.length > 0) {
      out.push(r.metadata);
    }
  }
  return out;
}

/**
 * Count messages in a conversation that were created strictly after the
 * `afterMessageId` reference message. If `afterMessageId` is `null` or empty,
 * counts all messages in the conversation. If the referenced message no
 * longer exists (e.g. deleted by a separate flow), returns 0 — callers
 * decide how to react to a vanished reference, and the conservative answer
 * here is "no new work."
 *
 * Used by the memory-retrospective trigger check to decide whether to fire
 * the message-count trigger without loading message bodies.
 */
export function countMessagesAfter(
  conversationId: string,
  afterMessageId: string | null,
): number {
  const db = getDb();
  if (afterMessageId === null || afterMessageId === "") {
    const row = db
      .select({ c: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .get();
    return row?.c ?? 0;
  }
  const ref = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, afterMessageId))
    .get();
  if (!ref) return 0;
  // Tie-breaker on `messages.id` so rows that share a millisecond timestamp
  // with the reference are not permanently skipped. Mirrors the
  // `(createdAt, id)` cursor pattern used by the backfill job-handler and
  // turn-events-store.
  const row = db
    .select({ c: count() })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        or(
          gt(messages.createdAt, ref.createdAt),
          and(
            eq(messages.createdAt, ref.createdAt),
            gt(messages.id, afterMessageId),
          ),
        ),
      ),
    )
    .get();
  return row?.c ?? 0;
}

/**
 * Return messages in a conversation created strictly after the
 * `afterMessageId` reference. If the reference is `null`/empty, returns all
 * messages. If the reference doesn't exist, returns an empty array (mirrors
 * `countMessagesAfter`'s conservative semantics). Used by the
 * memory-retrospective job handler to load the message slice it processes.
 */
export function getMessagesAfter(
  conversationId: string,
  afterMessageId: string | null,
): MessageRow[] {
  const db = getDb();
  if (afterMessageId === null || afterMessageId === "") {
    // Secondary `asc(messages.id)` matches the non-null path's cursor
    // ordering, so callers tracking `cutoffMessageId` across runs see a
    // consistent ordering when multiple rows share a millisecond timestamp.
    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all()
      .map(parseMessage);
  }
  const ref = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, afterMessageId))
    .get();
  if (!ref) return [];
  // Same `(createdAt, id)` cursor as `countMessagesAfter` — rows sharing
  // the reference's millisecond timestamp would otherwise be skipped.
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        or(
          gt(messages.createdAt, ref.createdAt),
          and(
            eq(messages.createdAt, ref.createdAt),
            gt(messages.id, afterMessageId),
          ),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all()
    .map(parseMessage);
}

/**
 * Efficient existence check — returns true if the conversation has at least
 * one message row. Uses `LIMIT 1` + `select({ 1 })` to avoid loading and
 * parsing any message content.
 */
export function hasMessages(conversationId: string): boolean {
  const db = getDb();
  const row = db
    .select({ one: sql`1` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .limit(1)
    .get();
  return row !== undefined;
}

interface PaginatedMessagesResult {
  messages: MessageRow[];
  hasMore: boolean;
  /**
   * Position of the last row scanned when the loop stops on
   * `PAGINATION_SCAN_CAP` rather than DB exhaustion. Callers derive their
   * client cursor from the visible page's oldest row, but a cap-truncated
   * page can be empty (a contiguous block of filtered-out rows longer than
   * the cap), leaving nothing to resume from. Surfacing the last scanned
   * `(createdAt, id)` lets the caller hand the client a cursor so it can
   * request the next window and keep draining instead of stalling.
   */
  nextCursor?: { createdAt: number; id: string };
}

const PAGINATION_CHUNK_MIN = 50;
const PAGINATION_SCAN_CAP = 10_000;

// Test-only override for PAGINATION_SCAN_CAP so tests can exercise the
// cap-truncation branch with a small cap instead of seeding >10k rows (which
// makes the suite slow and the post-test DELETE flaky under parallel CI load).
// `undefined` restores the production cap.
let paginationScanCapOverride: number | undefined;
export function _setPaginationScanCapForTesting(cap: number | undefined): void {
  paginationScanCapOverride = cap;
}

export function getMessagesPaginated(
  conversationId: string,
  limit: number | undefined,
  beforeTimestamp?: number,
  filter?: (row: MessageRow) => boolean,
): PaginatedMessagesResult {
  const db = getDb();

  if (limit === undefined) {
    const conditions = [eq(messages.conversationId, conversationId)];
    if (beforeTimestamp !== undefined) {
      conditions.push(lt(messages.createdAt, beforeTimestamp));
    }
    const rows = db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.createdAt))
      .all()
      .map(parseMessage);
    return {
      messages: filter ? rows.filter(filter) : rows,
      hasMore: false,
    };
  }

  // Walk pages newest→oldest, applying `filter` in TS (metadata parsing is
  // JSON, not a structured column). Keep fetching until we have `limit + 1`
  // visible rows or the DB is exhausted, so `hasMore` and the cursor reflect
  // the visible page rather than the unfiltered row count. Without this loop,
  // a fully-hidden page returns `{ messages: [], hasMore: true }` with no
  // cursor, which stalls the web client's older-page fetch.
  let cursorCreatedAt = beforeTimestamp;
  let cursorMessageId: string | undefined;
  const visible: MessageRow[] = [];
  const chunkSize = Math.max(limit + 1, PAGINATION_CHUNK_MIN);
  // Bound the work a single request can do when `filter` rejects nearly every
  // row — otherwise a pathological filter against a huge conversation would
  // tie up a connection for thousands of roundtrips.
  let rowsScanned = 0;
  // Distinguish "stopped because we hit the scan cap" from "stopped because the
  // DB ran out of rows". On a cap-truncated stop there may be more visible rows
  // past the scanned window, so `hasMore` must stay true and we record the last
  // scanned position as a resume cursor (the visible page may be empty).
  let scanCapTruncated = false;
  let lastScanned: { createdAt: number; id: string } | undefined;
  const scanCap = paginationScanCapOverride ?? PAGINATION_SCAN_CAP;

  while (visible.length < limit + 1) {
    if (rowsScanned >= scanCap) {
      scanCapTruncated = true;
      break;
    }
    const cursorPredicate =
      cursorCreatedAt === undefined
        ? undefined
        : cursorMessageId === undefined
          ? lt(messages.createdAt, cursorCreatedAt)
          : or(
              lt(messages.createdAt, cursorCreatedAt),
              and(
                eq(messages.createdAt, cursorCreatedAt),
                lt(messages.id, cursorMessageId),
              ),
            );

    const chunk = db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), cursorPredicate))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(chunkSize)
      .all()
      .map(parseMessage);

    if (chunk.length === 0) break;
    rowsScanned += chunk.length;

    for (const row of chunk) {
      if (!filter || filter(row)) visible.push(row);
      if (visible.length >= limit + 1) break;
    }

    if (chunk.length < chunkSize) break;
    const lastRow = chunk[chunk.length - 1];
    lastScanned = { createdAt: lastRow.createdAt, id: lastRow.id };
    cursorCreatedAt = lastRow.createdAt;
    cursorMessageId = lastRow.id;
  }

  const filledPage = visible.length > limit;
  // A cap-truncated stop means the DB may still hold older visible rows past
  // the scanned window, so report `hasMore: true` to keep the client draining
  // — returning `false` here is the stall this loop exists to prevent.
  const hasMore = filledPage || scanCapTruncated;
  if (filledPage) visible.splice(limit);
  visible.reverse();

  // Only hand back a resume cursor when the cap (not DB exhaustion) cut the
  // search short; callers fall back to it when the visible page came back
  // empty and has no oldest row to anchor the next request.
  const nextCursor = scanCapTruncated ? lastScanned : undefined;

  return { messages: visible, hasMore, nextCursor };
}

export function getLastUserTimestampBefore(
  conversationId: string,
  beforeTimestamp: number,
): number {
  const db = getDb();
  const row = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
        lt(messages.createdAt, beforeTimestamp),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get();
  return row?.createdAt ?? 0;
}

/**
 * Most recent user-message timestamp (epoch ms) across all conversations, or
 * `0` when no user message exists.
 *
 * Ordered by `created_at` rather than insertion order, because `forkConversation`
 * copies a parent's messages into the fork while preserving their original
 * `created_at`. Those copies receive fresh row ids, so an insertion-order scan
 * could surface an old forked turn as if it were the latest activity and let
 * maintenance run while the user is in fact active. The `(role, created_at)`
 * index (`idx_messages_role_created_at`) makes this an indexed seek to the
 * newest `role = "user"` row rather than a scan of the whole (potentially
 * multi-GB) table.
 */
export function getLastUserMessageTimestamp(): number {
  const db = getDb();
  const row = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.role, "user"))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get();
  return row?.createdAt ?? 0;
}

/** Fetch a single message by ID, optionally scoped to a specific conversation. */
export function getMessageById(
  messageId: string,
  conversationId?: string,
): MessageRow | null {
  const db = getDb();
  const conditions = [eq(messages.id, messageId)];
  if (conversationId) {
    conditions.push(eq(messages.conversationId, conversationId));
  }
  const row = db
    .select()
    .from(messages)
    .where(and(...conditions))
    .get();
  return row ? parseMessage(row) : null;
}

export function updateConversationTitle(
  id: string,
  title: string,
  isAutoTitle?: number,
): void {
  const db = getDb();
  const set: Record<string, unknown> = { title, updatedAt: Date.now() };
  if (isAutoTitle !== undefined) set.isAutoTitle = isAutoTitle;
  db.update(conversations).set(set).where(eq(conversations.id, id)).run();

  // Update disk view meta.json with the new title
  const conv = getConversation(id);
  if (conv) {
    updateMetaFile(conv);
  }
}

export function updateConversationUsage(
  id: string,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalEstimatedCost: number,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCost,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, id))
    .run();
}

export function updateConversationContextWindow(
  id: string,
  contextSummary: string,
  contextCompactedMessageCount: number,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      contextSummary,
      contextCompactedMessageCount,
      contextCompactedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, id))
    .run();
}

export function setConversationHistoryStrippedAt(
  id: string,
  historyStrippedAt: number | null,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      historyStrippedAt,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, id))
    .run();
}

export function updateConversationSlackContextWatermark(
  id: string,
  watermarkTs: string,
  compactedAt: number = Date.now(),
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      slackContextCompactionWatermarkTs: watermarkTs,
      slackContextCompactionWatermarkAt: compactedAt,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, id))
    .run();
}

export function archiveConversation(id: string): boolean {
  const conv = getConversation(id);
  if (!conv) return false;
  const now = Date.now();
  rawRun(
    "UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?",
    now,
    now,
    id,
  );
  return true;
}

export function unarchiveConversation(id: string): boolean {
  const conv = getConversation(id);
  if (!conv) return false;
  const now = Date.now();
  rawRun(
    "UPDATE conversations SET archived_at = NULL, updated_at = ? WHERE id = ?",
    now,
    id,
  );
  return true;
}

/**
 * Set or clear the `surfaced_at` promotion marker for a conversation.
 *
 * A non-null `surfaced_at` promotes a background/scheduled conversation
 * into the default ("standard") conversation listing so clients show it in
 * the Recents sidebar grouping. Promotion is always explicit — callers are
 * product flows that decide a background run deserves foreground visibility
 * (e.g. the user sent a follow-up message in it). Nothing sets this
 * automatically.
 *
 * Returns `null` when the conversation does not exist; otherwise the new
 * `surfacedAt` value (`number` when surfacing, `null` when clearing).
 */
export function setConversationSurfaced(
  id: string,
  surfaced: boolean,
): { surfacedAt: number | null } | null {
  const conv = getConversation(id);
  if (!conv) return null;
  const now = Date.now();
  const surfacedAt = surfaced ? now : null;
  rawRun(
    "UPDATE conversations SET surfaced_at = ?, updated_at = ? WHERE id = ?",
    surfacedAt,
    now,
    id,
  );
  return { surfacedAt };
}

/**
 * Set or clear the inference profile override for a conversation.
 * Pass `null` to clear the override and fall back to the workspace
 * `llm.activeProfile` resolution.
 *
 * Also clears any stale session columns (`inferenceProfileSessionId`,
 * `inferenceProfileExpiresAt`) so that the reaper and lazy expiry check
 * cannot later clobber the newly-set profile.
 */
export function setConversationInferenceProfile(
  conversationId: string,
  profile: string | null,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      inferenceProfile: profile,
      inferenceProfileSessionId: null,
      inferenceProfileExpiresAt: null,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, conversationId))
    .run();
}

/**
 * Atomically set the inference profile, session id, and expiry timestamp for
 * a conversation. Pass `null` for all three to clear the session-backed
 * override and fall back to the workspace `llm.activeProfile` resolution.
 */
export function setConversationInferenceProfileSession(
  conversationId: string,
  profile: string | null,
  sessionId: string | null,
  expiresAt: number | null,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      inferenceProfile: profile,
      inferenceProfileSessionId: sessionId,
      inferenceProfileExpiresAt: expiresAt,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, conversationId))
    .run();
}

/**
 * Clear all conversations whose session-backed inference profile has expired.
 * Returns an array of `{ conversationId, sessionId }` for each cleared row so
 * callers can emit the appropriate update events.
 */
export function clearExpiredInferenceProfiles(
  now: number,
): Array<{ conversationId: string; sessionId: string | null }> {
  const raw = getSqliteFrom(getDb());
  // Two-step approach: SELECT to get pre-clear sessionIds, then UPDATE.
  // The UPDATE re-applies the WHERE condition for CAS safety.
  // RETURNING the id lets us know which rows were actually cleared.
  const expired = raw
    .prepare(
      `
    SELECT id AS conversationId, inference_profile_session_id AS sessionId
    FROM conversations
    WHERE inference_profile_expires_at IS NOT NULL AND inference_profile_expires_at <= ?
  `,
    )
    .all(now) as Array<{ conversationId: string; sessionId: string | null }>;

  if (expired.length === 0) return [];

  const ids = expired.map((r) => r.conversationId);
  const placeholders = ids.map(() => "?").join(", ");

  const actuallyCleared = raw
    .prepare(
      `
    UPDATE conversations
    SET inference_profile = NULL, inference_profile_session_id = NULL, inference_profile_expires_at = NULL
    WHERE id IN (${placeholders}) AND inference_profile_expires_at IS NOT NULL AND inference_profile_expires_at <= ?
    RETURNING id AS conversationId
  `,
    )
    .all(...ids, now) as Array<{ conversationId: string }>;

  const clearedSet = new Set(actuallyCleared.map((r) => r.conversationId));
  return expired.filter((r) => clearedSet.has(r.conversationId));
}

/**
 * List conversations with an active (non-expired) session-backed inference
 * profile. Pass a `conversationId` to narrow to a single conversation.
 */
export function listActiveInferenceProfileSessions(
  conversationId?: string,
): Array<{
  conversationId: string;
  conversationTitle: string | null;
  profile: string;
  sessionId: string;
  expiresAt: number;
}> {
  const db = getDb();
  const now = Date.now();
  const baseConditions = [
    isNotNull(conversations.inferenceProfile),
    isNotNull(conversations.inferenceProfileExpiresAt),
    gt(conversations.inferenceProfileExpiresAt, now),
    isNotNull(conversations.inferenceProfileSessionId),
  ];
  if (conversationId) {
    baseConditions.push(eq(conversations.id, conversationId));
  }
  return db
    .select({
      conversationId: conversations.id,
      conversationTitle: conversations.title,
      profile: conversations.inferenceProfile,
      sessionId: conversations.inferenceProfileSessionId,
      expiresAt: conversations.inferenceProfileExpiresAt,
    })
    .from(conversations)
    .where(and(...baseConditions))
    .all() as Array<{
    conversationId: string;
    conversationTitle: string | null;
    profile: string;
    sessionId: string;
    expiresAt: number;
  }>;
}

/**
 * The conversation fields needed to resolve a per-turn inference-profile
 * override. Satisfied by both the DB {@link ConversationRow} and the live
 * in-memory `Conversation`, so callers can derive the override from whichever
 * representation they already hold without a redundant row fetch.
 */
export interface OverrideProfileFields {
  conversationType?: string | null;
  inferenceProfile?: string | null;
  inferenceProfileExpiresAt?: number | null;
}

/**
 * Resolve the per-turn inference-profile override from a conversation's
 * fields. Returns the `inferenceProfile` for interactive conversations,
 * `undefined` for automation threads (subagent fan-out, scheduled
 * tasks) so they run on the workspace defaults rather than
 * inheriting an interactive override.
 */
export function resolveOverrideProfile(
  fields: OverrideProfileFields | null,
): string | undefined {
  if (
    fields?.conversationType === "background" ||
    fields?.conversationType === "scheduled"
  ) {
    return undefined;
  }
  // Treat an expired session as if the override is absent. The eager reaper
  // clears the row and emits the update event; the lazy check here ensures
  // correctness on read paths before the reaper fires.
  //
  // `<=` (not `<`) for boundary consistency with the rest of the session
  // logic: the reaper SQL uses `expires_at <= ?`, and the active-session
  // queries use `expiresAt > now` (i.e. treat exact-expiry as inactive).
  // Without this, a session at the exact-expiry millisecond would be served
  // for one extra turn here while being cleared by the reaper.
  if (
    fields?.inferenceProfileExpiresAt != null &&
    fields.inferenceProfileExpiresAt <= Date.now()
  ) {
    return undefined;
  }
  return fields?.inferenceProfile ?? undefined;
}

/**
 * Resolve the per-turn inference-profile override by conversation id.
 * Convenience wrapper for standalone callers (e.g. subagent spawn,
 * opportunity-wake) that don't already have the conversation in hand.
 */
export function getConversationOverrideProfile(
  conversationId: string,
): string | undefined {
  return resolveOverrideProfile(getConversation(conversationId));
}

export function setLastNotifiedInferenceProfile(
  conversationId: string,
  profileKey: string | null,
): void {
  rawRun(
    "UPDATE conversations SET last_notified_inference_profile = ? WHERE id = ?",
    profileKey,
    conversationId,
  );
}

/**
 * Delete all conversations, messages, and related data (tool invocations,
 * memory segments, etc.) from the daemon database.
 * Returns { conversations, messages } counts.
 *
 * Each bulk DELETE is dispatched through {@link runAsyncSqlite}: when
 * the host has a `sqlite3` CLI it executes in a subprocess and the
 * daemon's main event loop stays responsive while large tables
 * (`llm_request_logs`, `tool_invocations`, etc.) are wiped. On hosts
 * without the CLI the abstraction falls back to in-process blocking
 * execution — the same behaviour the daemon had before.
 */
export async function clearAll(): Promise<{
  conversations: number;
  messages: number;
}> {
  const msgCount =
    rawGet<{ c: number }>("SELECT COUNT(*) AS c FROM messages")?.c ?? 0;
  const convCount =
    rawGet<{ c: number }>("SELECT COUNT(*) AS c FROM conversations")?.c ?? 0;

  // Each DELETE goes through `runAsyncSqlite`. The original code threw
  // on rawExec failure; mirror that here by throwing when the async
  // result reports `ok: false`, so the route handler still returns 500.
  const runOrThrow = async (sql: string): Promise<void> => {
    const result = await runAsyncSqlite(sql);
    if (!result.ok) {
      throw new Error(
        `clearAll: \`${sql}\` failed (${result.backend}): ${result.error ?? "unknown"}`,
      );
    }
  };

  // Delete in dependency order. Cascades handle memory_segments and
  // tool_invocations, but we explicitly clear non-cascading memory
  // tables too.
  //
  // FTS virtual tables are cleared before their base tables. If an FTS
  // table is corrupted, the DELETE will fail — we drop the associated
  // triggers so that the subsequent base-table DELETEs don't also fail
  // (SQLite triggers are atomic with the triggering statement, so a
  // corrupted FTS table would roll back every base-table DELETE).
  await runOrThrow("DELETE FROM memory_segments");
  await runOrThrow("DELETE FROM memory_summaries");
  await runOrThrow("DELETE FROM memory_embeddings");
  await runOrThrow("DELETE FROM memory_jobs");
  await runOrThrow("DELETE FROM memory_checkpoints");
  await runOrThrow("DELETE FROM llm_request_logs");
  await runOrThrow("DELETE FROM llm_usage_events");
  await runOrThrow("DELETE FROM message_attachments");
  await runOrThrow("DELETE FROM attachments");
  await runOrThrow("DELETE FROM tool_invocations");
  await runOrThrow("DELETE FROM skill_loaded_events");
  let messagesFtsCorrupted = false;
  const ftsResult = await runAsyncSqlite("DELETE FROM messages_fts");
  if (!ftsResult.ok) {
    log.warn(
      { error: ftsResult.error, backend: ftsResult.backend },
      "clearAll: failed to clear messages_fts — dropping triggers so base-table cleanup can proceed",
    );
    rawExec("DROP TRIGGER IF EXISTS messages_fts_ai");
    rawExec("DROP TRIGGER IF EXISTS messages_fts_ad");
    rawExec("DROP TRIGGER IF EXISTS messages_fts_au");
    messagesFtsCorrupted = true;
  }
  await runOrThrow("DELETE FROM messages");
  await runOrThrow("DELETE FROM conversations");

  // Record audit event — lifecycle_events is NOT deleted by clearAll(),
  // so this survives the wipe and provides a permanent trail.
  rawRun(
    `INSERT INTO lifecycle_events (id, event_name, created_at) VALUES (?, ?, ?)`,
    uuid(),
    "conversations_clear_all",
    Date.now(),
  );

  // Rebuild corrupted FTS tables and restore triggers after all base-table
  // DELETEs have completed. Dropping the virtual table clears the corruption,
  // and recreating it + triggers means subsequent writes maintain FTS
  // consistency without requiring a daemon restart.
  if (messagesFtsCorrupted) {
    rawExec("DROP TABLE IF EXISTS messages_fts");
    rawExec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content)`,
    );
    rawExec(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content); END`,
    );
    rawExec(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE message_id = old.id; END`,
    );
    rawExec(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN DELETE FROM messages_fts WHERE message_id = old.id; INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content); END`,
    );
  }

  // Clear the disk-view conversations directory and recreate it empty
  try {
    rmSync(getConversationsDir(), { recursive: true, force: true });
    mkdirSync(getConversationsDir(), { recursive: true });
  } catch (err) {
    log.warn({ err }, "clearAll: failed to reset conversations directory");
  }

  void clearAllConversationIds();

  return { conversations: convCount, messages: msgCount };
}

export function deleteLastExchange(conversationId: string): number {
  const db = getDb();

  // Find the last user message's id
  const lastUserMsg = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
      ),
    )
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();

  if (!lastUserMsg) return 0;

  // Use rowid to identify the last user message and everything after it.
  // rowid is monotonically increasing for inserts, so this is safe even if
  // multiple messages share the same millisecond timestamp.
  const rowidSubquery = sql`(SELECT rowid FROM messages WHERE id = ${lastUserMsg.id})`;
  const condition = and(
    eq(messages.conversationId, conversationId),
    sql`rowid >= ${rowidSubquery}`,
  );

  const [{ deleted }] = db
    .select({ deleted: count() })
    .from(messages)
    .where(condition)
    .all();
  if (deleted === 0) return 0;

  // Collect attachment IDs linked to the messages being deleted so we can
  // scope orphan cleanup to only those candidates (not freshly uploaded ones).
  const messageIds = db
    .select({ id: messages.id })
    .from(messages)
    .where(condition)
    .all()
    .map((r) => r.id);
  const candidateAttachmentIds =
    messageIds.length > 0
      ? db
          .select({ attachmentId: messageAttachments.attachmentId })
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, messageIds))
          .all()
          .map((r) => r.attachmentId)
          .filter((id): id is string => id != null)
      : [];

  db.transaction((tx) => {
    tx.delete(messages).where(condition).run();
    const maxResult = tx
      .select({ maxCreatedAt: sql<number | null>`MAX(${messages.createdAt})` })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .get();
    tx.update(conversations)
      .set({
        updatedAt: Date.now(),
        lastMessageAt: maxResult?.maxCreatedAt ?? null,
      })
      .where(eq(conversations.id, conversationId))
      .run();
  });

  deleteOrphanAttachments(candidateAttachmentIds);

  return deleted;
}

/**
 * IDs collected during message deletion for Qdrant vector cleanup.
 * Callers must delete these from the Qdrant collection after the
 * SQLite transaction commits.
 */
interface DeletedMemoryIds {
  segmentIds: string[];
  deletedSummaryIds: string[];
}

interface WipeConversationResult extends DeletedMemoryIds {
  cancelledJobCount: number;
}

/**
 * Reserve an empty message row so the agent loop can stamp outbound
 * streaming events with a stable identity before content is produced.
 *
 * Intentionally skips Qdrant indexing and attention projection — an empty
 * placeholder is meaningless for either. The caller writes final content
 * via {@link updateMessageContent} and handles indexing/projection itself.
 *
 * Delegates the core insert + retry logic to {@link insertMessageCore}.
 */
export async function reserveMessage(
  conversationId: string,
  role: MessageRole,
  metadata?: Record<string, unknown>,
) {
  return insertMessageCore({
    conversationId,
    role,
    content: "[]",
    metadata,
  });
}

/**
 * Update the content of an existing message. Used when consolidating
 * multiple assistant messages into one.
 */
export function updateMessageContent(
  messageId: string,
  newContent: string,
): void {
  const db = getDb();
  db.update(messages)
    .set({ content: newContent })
    .where(eq(messages.id, messageId))
    .run();
}

/**
 * Merge `updates` into the metadata JSON of an existing message.
 * Reads the current metadata, shallow-merges the new fields, and writes back.
 */
export function updateMessageMetadata(
  messageId: string,
  updates: Record<string, unknown>,
): void {
  const db = getDb();
  const row = db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  const existing = row?.metadata ? JSON.parse(row.metadata) : {};
  db.update(messages)
    .set({ metadata: JSON.stringify({ ...existing, ...updates }) })
    .where(eq(messages.id, messageId))
    .run();
}

/**
 * Atomically update both `content` and (shallow-merged) `metadata` for a
 * message. Used by edit-propagation paths that need to update the message
 * body and stamp metadata (e.g. `slackMeta.editedAt`) in a single
 * transaction so a partial write cannot leak.
 *
 * `metadataUpdates` is shallow-merged into the existing top-level metadata
 * object. To merge into a nested sub-key (e.g. `slackMeta`), the caller
 * must compute the merged sub-value first and pass `{ slackMeta: merged }`.
 */
export function updateMessageContentAndMetadata(
  messageId: string,
  newContent: string,
  metadataUpdates: Record<string, unknown>,
): void {
  const db = getDb();
  db.transaction((tx) => {
    const row = tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    const existing = row?.metadata ? safeParseRecord(row.metadata) : {};
    tx.update(messages)
      .set({
        content: newContent,
        metadata: JSON.stringify({ ...existing, ...metadataUpdates }),
      })
      .where(eq(messages.id, messageId))
      .run();
  });
}

/**
 * Re-link all attachments from a set of source messages to a target message.
 * Used during message consolidation so that attachments linked to deleted
 * messages survive the ON DELETE CASCADE on message_attachments.
 */
export function relinkAttachments(
  fromMessageIds: string[],
  toMessageId: string,
): number {
  if (fromMessageIds.length === 0) return 0;
  const db = getDb();

  // Count how many links will be moved before updating.
  const [{ total }] = db
    .select({ total: count() })
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, fromMessageIds))
    .all();

  if (total === 0) return 0;

  db.update(messageAttachments)
    .set({ messageId: toMessageId })
    .where(inArray(messageAttachments.messageId, fromMessageIds))
    .run();

  return total;
}

/**
 * Delete a single message by ID without cascading to message_runs or
 * channel_inbound_events. Nullable FK columns in those tables are set to
 * NULL before the message row is removed, so associated run and event
 * records survive.
 *
 * Returns segment IDs so the caller can clean up the corresponding
 * Qdrant vector entries.
 */
export function deleteMessageById(messageId: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = {
    segmentIds: [],
    deletedSummaryIds: [],
  };

  // Collect attachment IDs linked to this message before cascade-delete
  // so we can scope orphan cleanup to only those candidates.
  const candidateAttachmentIds = db
    .select({ attachmentId: messageAttachments.attachmentId })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .all()
    .map((r) => r.attachmentId)
    .filter((id): id is string => id !== undefined);

  // Look up the conversation before the transaction so we can recalculate lastMessageAt.
  const msgRow = db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();

  db.transaction((tx) => {
    // Collect memory segment IDs linked to this message before cascade.
    const linkedSegments = tx
      .select({ id: memorySegments.id })
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();
    result.segmentIds = linkedSegments.map((r) => r.id);

    // Detach nullable FK references so the cascade doesn't destroy them.
    tx.update(channelInboundEvents)
      .set({ messageId: null })
      .where(eq(channelInboundEvents.messageId, messageId))
      .run();

    // Now safe to delete — NOT NULL cascades remove memory_segments
    // and message_attachments.
    tx.delete(messages).where(eq(messages.id, messageId)).run();

    // Recalculate lastMessageAt after deletion.
    if (msgRow) {
      const maxResult = tx
        .select({
          maxCreatedAt: sql<number | null>`MAX(${messages.createdAt})`,
        })
        .from(messages)
        .where(eq(messages.conversationId, msgRow.conversationId))
        .get();
      tx.update(conversations)
        .set({ lastMessageAt: maxResult?.maxCreatedAt ?? null })
        .where(eq(conversations.id, msgRow.conversationId))
        .run();
    }

    // Clean up segment embeddings from SQLite (Qdrant cleanup is the caller's job).
    if (result.segmentIds.length > 0) {
      tx.delete(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.targetType, "segment"),
            inArray(memoryEmbeddings.targetId, result.segmentIds),
          ),
        )
        .run();
    }
  });

  deleteOrphanAttachments(candidateAttachmentIds);

  return result;
}

export function setConversationOriginChannelIfUnset(
  conversationId: string,
  channel: ChannelId,
): void {
  const db = getDb();
  db.update(conversations)
    .set({ originChannel: channel })
    .where(
      and(
        eq(conversations.id, conversationId),
        isNull(conversations.originChannel),
      ),
    )
    .run();
}

export function getConversationOriginChannel(
  conversationId: string,
): ChannelId | null {
  const db = getDb();
  const row = db
    .select({ originChannel: conversations.originChannel })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return parseChannelId(row?.originChannel) ?? null;
}

export function setConversationOriginInterfaceIfUnset(
  conversationId: string,
  interfaceId: InterfaceId,
): void {
  const db = getDb();
  db.update(conversations)
    .set({ originInterface: interfaceId })
    .where(
      and(
        eq(conversations.id, conversationId),
        isNull(conversations.originInterface),
      ),
    )
    .run();
}

export function getConversationOriginInterface(
  conversationId: string,
): InterfaceId | null {
  const db = getDb();
  const row = db
    .select({ originInterface: conversations.originInterface })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return parseInterfaceId(row?.originInterface) ?? null;
}

/**
 * Return the most recent non-null provenanceTrustClass from user messages
 * in the given conversation, or `undefined` if none is found.
 *
 * Used by the pointer message trust resolver to detect conversations
 * whose audience is a guardian or trusted_contact outside desktop-origin
 * conversations.
 */
export function getConversationRecentProvenanceTrustClass(
  conversationId: string,
): "guardian" | "trusted_contact" | "unknown" | undefined {
  const row = rawGet<{ metadata: string | null }>(
    `SELECT metadata FROM messages
     WHERE conversation_id = ? AND role = 'user' AND metadata IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    conversationId,
  );
  if (!row?.metadata) return undefined;
  try {
    const parsed = messageMetadataSchema.safeParse(JSON.parse(row.metadata));
    return parsed.success ? parsed.data.provenanceTrustClass : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CRUD functions for display_order and is_pinned
// ---------------------------------------------------------------------------

export function batchSetDisplayOrders(
  updates: Array<{
    id: string;
    displayOrder: number | null;
    isPinned?: boolean;
    groupId?: string | null;
  }>,
): void {
  ensureDisplayOrderMigration();
  ensureGroupMigration();
  rawExec("BEGIN");
  try {
    for (const update of updates) {
      if (update.groupId !== undefined) {
        // New client: groupId is authoritative.
        // Derive is_pinned from groupId.
        // Sanitize: if groupId is null or references a deleted/unknown group,
        // fall back to "system:all" to avoid FK violation that would roll back
        // the entire batch.
        let safeGroupId = update.groupId;
        if (safeGroupId === null) {
          safeGroupId = "system:all";
        } else if (
          !rawGet<{ id: string }>(
            "SELECT id FROM conversation_groups WHERE id = ?",
            safeGroupId,
          )
        ) {
          safeGroupId = "system:all";
        }
        // Moving a conversation into the Scheduled/Background system groups
        // is an explicit demotion out of Recents, so clear any `surfaced_at`
        // promotion in the same write — otherwise the surfaced marker would
        // keep the row in the standard listing and the move would appear to
        // do nothing.
        const clearsSurfaced =
          safeGroupId === "system:background" ||
          safeGroupId === "system:scheduled";
        rawRun(
          `UPDATE conversations SET display_order = ?, is_pinned = ?, group_id = ?${
            clearsSurfaced ? ", surfaced_at = NULL" : ""
          } WHERE id = ?`,
          update.displayOrder,
          safeGroupId === "system:pinned" ? 1 : 0,
          safeGroupId,
          update.id,
        );
      } else if (update.isPinned === undefined) {
        // Only displayOrder provided — preserve existing pin state and group.
        rawRun(
          "UPDATE conversations SET display_order = ? WHERE id = ?",
          update.displayOrder,
          update.id,
        );
      } else if (update.isPinned) {
        rawRun(
          "UPDATE conversations SET display_order = ?, is_pinned = 1, group_id = 'system:pinned' WHERE id = ?",
          update.displayOrder,
          update.id,
        );
      } else {
        // Restore system group from source/conversationType when unpinning,
        // instead of clearing to NULL (which would lose provenance).
        rawRun(
          `UPDATE conversations SET display_order = ?, is_pinned = 0,
           group_id = CASE WHEN group_id = 'system:pinned' THEN
             CASE
               WHEN source IN ('schedule', 'reminder') THEN 'system:scheduled'
               WHEN source IN ('heartbeat', 'task') THEN 'system:background'
               WHEN conversation_type = 'background' AND COALESCE(source, '') != 'notification' THEN 'system:background'
               ELSE 'system:all'
             END
           ELSE group_id END
           WHERE id = ?`,
          update.displayOrder,
          update.id,
        );
      }
    }
    rawExec("COMMIT");
  } catch (err) {
    rawExec("ROLLBACK");
    throw err;
  }
}

export function getDisplayMetaForConversations(
  conversationIds: string[],
): Map<
  string,
  { displayOrder: number | null; isPinned: boolean; groupId: string | null }
> {
  ensureDisplayOrderMigration();
  ensureGroupMigration();
  const result = new Map<
    string,
    { displayOrder: number | null; isPinned: boolean; groupId: string | null }
  >();
  if (conversationIds.length === 0) return result;
  for (const id of conversationIds) {
    const row = rawGet<{
      display_order: number | null;
      is_pinned: number | null;
      group_id: string | null;
    }>(
      "SELECT display_order, is_pinned, group_id FROM conversations WHERE id = ?",
      id,
    );
    result.set(id, {
      displayOrder: row?.display_order ?? null,
      isPinned: (row?.is_pinned ?? 0) === 1,
      groupId: row?.group_id ?? null,
    });
  }
  return result;
}

// ── Turn boundary resolution ─────────────────────────────────────────

/**
 * Returns `true` if a message is a tool-result user message — i.e. its
 * role is "user" and its content is a JSON array where every block has
 * `type === "tool_result"`. These synthetic user messages are injected
 * between assistant messages within a single agent turn and should NOT
 * be treated as turn boundaries.
 */
function isToolResultMessage(role: string, content: string): boolean {
  if (role !== "user") return false;
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.every(
      (block: unknown) =>
        block != null &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "tool_result",
    );
  } catch {
    return false;
  }
}

/**
 * Returns the time boundaries (start/end `createdAt` values) for the turn
 * containing the given message. The bounds span from the real user message
 * that started the turn to just before the real user message that starts the
 * next turn (or to the end of the conversation if this is the last turn).
 *
 * Also extends the end boundary to capture orphaned LLM request logs from
 * deleted intermediate messages (e.g. removed by retry/deleteLastExchange).
 *
 * Returns null if the message is the only one in the conversation.
 */
export function getTurnTimeBounds(
  conversationId: string,
  messageCreatedAt: number,
): { startTime: number; endTime: number } | null {
  const db = getDb();

  // Walk backward (by rowid, not just createdAt) to find the real user
  // message that starts this turn.
  const rowidSubquery = sql`(
    SELECT rowid FROM messages
    WHERE conversation_id = ${conversationId}
      AND created_at <= ${messageCreatedAt}
    ORDER BY rowid DESC LIMIT 1
  )`;
  const backwardRows = db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`rowid <= ${rowidSubquery}`,
      ),
    )
    .orderBy(sql`rowid DESC`)
    .limit(50)
    .all();

  let startTime = messageCreatedAt;
  for (const row of backwardRows) {
    if (row.role === "user" && !isToolResultMessage(row.role, row.content)) {
      startTime = row.createdAt;
      break;
    }
  }

  // Walk forward (by rowid) to find the next real user message.
  const forwardRowidSubquery = sql`(
    SELECT rowid FROM messages
    WHERE conversation_id = ${conversationId}
      AND created_at >= ${messageCreatedAt}
    ORDER BY rowid DESC LIMIT 1
  )`;
  const forwardRows = db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`rowid > ${forwardRowidSubquery}`,
      ),
    )
    .orderBy(sql`rowid ASC`)
    .limit(50)
    .all();

  let endTime = messageCreatedAt;
  let nextTurnStart: number | null = null;
  for (const row of forwardRows) {
    if (row.role === "user" && !isToolResultMessage(row.role, row.content)) {
      nextTurnStart = row.createdAt;
      break;
    }
    endTime = row.createdAt;
  }

  // When the next turn start has a strictly greater timestamp, use it minus
  // 1ms as the hard upper bound. When timestamps collide (e.g. in tests),
  // don't extend — the message-ID-based query is authoritative.
  if (nextTurnStart != null && nextTurnStart > endTime) {
    endTime = nextTurnStart - 1;
  }

  // Extend end boundary to the latest log that falls within the turn window.
  // Orphaned logs from deleted intermediate messages may have timestamps
  // beyond any surviving message. Cap at 30 minutes to avoid sweeping in
  // logs from a much later turn.
  const MAX_TURN_DURATION_MS = 30 * 60 * 1000;
  const hardCeiling =
    nextTurnStart != null && nextTurnStart > startTime
      ? nextTurnStart - 1
      : startTime + MAX_TURN_DURATION_MS;

  if (hardCeiling > endTime) {
    const latestLog = db
      .select({ createdAt: llmRequestLogs.createdAt })
      .from(llmRequestLogs)
      .where(
        and(
          eq(llmRequestLogs.conversationId, conversationId),
          gte(llmRequestLogs.createdAt, startTime),
          lte(llmRequestLogs.createdAt, hardCeiling),
        ),
      )
      .orderBy(desc(llmRequestLogs.createdAt))
      .limit(1)
      .get();

    if (latestLog && latestLog.createdAt > endTime) {
      endTime = latestLog.createdAt;
    }
  }

  return { startTime, endTime };
}

/**
 * Resolve all assistant message IDs that belong to the same agent turn
 * as the given `messageId`. A "turn" is bounded by:
 *   - The start of the conversation, or
 *   - A user message whose content is NOT a tool_result array.
 *
 * Within a multi-step agent loop, the pattern is:
 *   user msg → assistant A1 → user (tool_result) → assistant A2 → ...
 * All assistant messages from A1 through the queried message (and beyond,
 * up to the next real user message) are part of the same turn.
 *
 * Returns `[messageId]` as a fallback if the message is not found,
 * preserving backward compatibility for callers.
 */
export function getAssistantMessageIdsInTurn(messageId: string): string[] {
  const db = getDb();

  // Look up the target message to get its conversationId and createdAt.
  const target = getMessageById(messageId);
  if (!target) return [messageId];

  // Walk backward from the target message to find the turn boundary.
  // Limit to 50 rows — sufficient for even aggressive tool-use loops.
  const backwardRows = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, target.conversationId),
        lte(messages.createdAt, target.createdAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(50)
    .all();

  const assistantIds: string[] = [];
  let boundaryCreatedAt: number | null = null;

  for (const row of backwardRows) {
    if (row.role === "assistant") {
      assistantIds.push(row.id);
    } else if (row.role === "user") {
      if (isToolResultMessage(row.role, row.content)) {
        // Tool-result user message — still within the same turn, continue.
        continue;
      }
      // Real user message — this is the turn boundary.
      boundaryCreatedAt = row.createdAt;
      break;
    }
  }

  // Walk forward from the target to collect any later assistant messages
  // still within the same turn (e.g. when querying an intermediate
  // message like A1 in a multi-step turn A1 → tool_result → A2).
  const forwardRows = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, target.conversationId),
        gt(messages.createdAt, target.createdAt),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(50)
    .all();

  for (const row of forwardRows) {
    if (row.role === "assistant") {
      if (!assistantIds.includes(row.id)) {
        assistantIds.push(row.id);
      }
    } else if (row.role === "user") {
      if (isToolResultMessage(row.role, row.content)) {
        // Tool-result user message — still within the same turn.
        continue;
      }
      // Real user message — end of the turn.
      break;
    }
  }

  // Also query forward from the backward-walk boundary to pick up any
  // assistant messages between the boundary and the target that may have
  // been missed (e.g. due to the 50-row limit in the backward walk).
  if (boundaryCreatedAt != null) {
    const gapRows = db
      .select({
        id: messages.id,
        role: messages.role,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, target.conversationId),
          gt(messages.createdAt, boundaryCreatedAt),
          lte(messages.createdAt, target.createdAt),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .all();

    for (const row of gapRows) {
      if (row.role === "assistant" && !assistantIds.includes(row.id)) {
        assistantIds.push(row.id);
      }
    }
  }

  // Sort by createdAt to ensure stable ordering.
  // Re-fetch createdAt for all collected IDs so the sort is accurate.
  if (assistantIds.length <= 1) return assistantIds;

  const idSet = new Set(assistantIds);
  const sorted = db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, target.conversationId),
        inArray(messages.id, [...idSet]),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .all();

  return sorted.map((r) => r.id);
}

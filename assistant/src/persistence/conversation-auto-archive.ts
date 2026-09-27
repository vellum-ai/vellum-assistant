import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { ACP_LIVE_STATUSES } from "../acp/types.js";
import { TERMINAL_STATUSES } from "../subagent/types.js";
import { unseenAttentionStateConditions } from "./conversation-attention-store.js";
import { ensureGroupMigration } from "./conversation-group-migration.js";
import {
  MEMORY_V2_CONSOLIDATION_SOURCE,
  NATIVE_ORIGIN_CHANNEL,
  PINNED_GROUP_ID,
} from "./conversation-types.js";
import { getDb } from "./db-connection.js";
import { rawChanges } from "./raw-query.js";
import {
  acpSessionHistory,
  conversationAssistantAttentionState,
  conversationModeSessions,
  conversations,
  externalConversationBindings,
  workflowRuns,
} from "./schema/index.js";

const activityAt = sql<number>`max(coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}), coalesce(${conversations.lastReopenedAt}, ${conversations.createdAt}))`;

export interface AutoArchiveCandidate {
  id: string;
  createdAt: number;
  lastMessageAt: number | null;
  lastReopenedAt: number | null;
  activityAt: number;
}

function eligibleForAutoArchive(cutoff: number) {
  const db = getDb();
  const origin = sql`coalesce((select ${externalConversationBindings.sourceChannel} from ${externalConversationBindings} where ${externalConversationBindings.conversationId} = ${conversations.id}), ${conversations.originChannel}, ${NATIVE_ORIGIN_CHANNEL})`;
  return and(
    isNull(conversations.archivedAt),
    isNull(conversations.processingStartedAt),
    eq(conversations.conversationType, "standard"),
    notInArray(conversations.source, [
      "subagent",
      "system",
      MEMORY_V2_CONSOLIDATION_SOURCE,
    ]),
    isNull(conversations.parentConversationId),
    isNull(conversations.scheduleJobId),
    sql`coalesce(group_id, 'system:all') not in (${PINNED_GROUP_ID}, 'system:background', 'system:scheduled')`,
    or(eq(origin, NATIVE_ORIGIN_CHANNEL), sql`${origin} like 'notification:%'`),
    lte(activityAt, cutoff),
    notExists(
      db
        .select({ id: conversationAssistantAttentionState.conversationId })
        .from(conversationAssistantAttentionState)
        .where(
          and(
            eq(
              conversationAssistantAttentionState.conversationId,
              conversations.id,
            ),
            ...unseenAttentionStateConditions(),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: acpSessionHistory.id })
        .from(acpSessionHistory)
        .where(
          and(
            eq(acpSessionHistory.parentConversationId, conversations.id),
            inArray(acpSessionHistory.status, [...ACP_LIVE_STATUSES]),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.conversationId, conversations.id),
            eq(workflowRuns.status, "running"),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: conversationModeSessions.id })
        .from(conversationModeSessions)
        .where(
          and(
            eq(conversationModeSessions.conversationId, conversations.id),
            eq(conversationModeSessions.status, "active"),
          ),
        ),
    ),
    sql`not exists (select 1 from subagents where parent_conversation_id = ${conversations.id} and status not in (${sql.join(
      [...TERMINAL_STATUSES].map((status) => sql`${status}`),
      sql`, `,
    )}))`,
  );
}

export function listAutoArchiveCandidates(options: {
  cutoff: number;
  limit: number;
  after?: Pick<AutoArchiveCandidate, "activityAt" | "id">;
}): AutoArchiveCandidate[] {
  ensureGroupMigration();
  return getDb()
    .select({
      id: conversations.id,
      createdAt: conversations.createdAt,
      lastMessageAt: conversations.lastMessageAt,
      lastReopenedAt: conversations.lastReopenedAt,
      activityAt,
    })
    .from(conversations)
    .where(
      and(
        eligibleForAutoArchive(options.cutoff),
        options.after
          ? or(
              gt(activityAt, options.after.activityAt),
              and(
                eq(activityAt, options.after.activityAt),
                gt(conversations.id, options.after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(activityAt), asc(conversations.id))
    .limit(options.limit)
    .all();
}

/** The sampled cursors and current eligibility are checked by the write itself. */
export function archiveInactiveConversation(
  candidate: AutoArchiveCandidate,
  cutoff: number,
  archivedAt: number,
): boolean {
  getDb()
    .update(conversations)
    .set({ archivedAt, updatedAt: archivedAt })
    .where(
      and(
        eq(conversations.id, candidate.id),
        eq(conversations.createdAt, candidate.createdAt),
        sql`${conversations.lastMessageAt} is ${candidate.lastMessageAt}`,
        sql`${conversations.lastReopenedAt} is ${candidate.lastReopenedAt}`,
        eligibleForAutoArchive(cutoff),
      ),
    )
    .run();
  return rawChanges() > 0;
}

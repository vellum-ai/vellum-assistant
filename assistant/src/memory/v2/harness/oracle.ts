/**
 * Oracle extraction — the current router's logged selections as silver-standard
 * ground truth.
 *
 * Source: `memory_v2_activation_logs` rows with `mode = 'router'`. Each row's
 * `messageId` is backfilled to the turn's assistant message (see
 * `backfillMemoryV2ActivationMessageId`), so we join `messageId → messages.id`
 * to anchor the turn — robust, no fragile turn-counting. Rows whose messageId
 * is null (the in-flight turn) or no longer resolves are skipped.
 *
 * Ground truth G(turn) = selected slugs with status ∈ {injected, in_context}
 * (what actually reached the model), optionally + not_injected, and — when a
 * `pageExists` predicate is supplied — only slugs whose page still exists
 * (neither retriever can find a nonexistent page). page_missing / corrupt are
 * always excluded.
 */

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { DrizzleDb } from "../../db-connection.js";
import type {
  MemoryV2ConceptRowRecord,
  MemoryV2ConfigSnapshot,
} from "../../memory-v2-activation-log-store.js";
import { memoryV2ActivationLogs, messages } from "../../schema.js";

export interface OracleTurn {
  conversationId: string;
  turn: number;
  /** Backfilled assistant-message id for this turn — the reconstruction anchor. */
  anchorMessageId: string;
  /** `created_at` of the anchor message; reconstruction cuts strictly before it. */
  anchorCreatedAt: number;
  /** Slugs the router's judgment put in front of the model (the recall target). */
  groundTruthSlugs: string[];
  loggedConfig: MemoryV2ConfigSnapshot;
  createdAt: number;
}

export interface ExtractOracleOptions {
  /** Max log rows to scan (default 50). Some are skipped, so result ≤ limit. */
  limit?: number;
  strategy?: "recent" | "random";
  conversationIds?: string[];
  /** Include status "not_injected" (selected but cut by the cap) in G. Default false. */
  includeNotInjected?: boolean;
  /**
   * Page-existence predicate, typically backed by `getPageIndex().bySlug`.
   * When provided, ground-truth slugs whose page no longer exists are dropped.
   * Omit in unit tests.
   */
  pageExists?: (slug: string) => boolean;
}

export function extractOracleTurns(
  db: DrizzleDb,
  options: ExtractOracleOptions = {},
): OracleTurn[] {
  const {
    limit = 50,
    strategy = "recent",
    conversationIds,
    includeNotInjected = false,
    pageExists,
  } = options;

  const allowedStatuses = new Set<string>(["injected", "in_context"]);
  if (includeNotInjected) allowedStatuses.add("not_injected");

  const filters = [
    eq(memoryV2ActivationLogs.mode, "router"),
    isNotNull(memoryV2ActivationLogs.messageId),
  ];
  if (conversationIds && conversationIds.length > 0) {
    filters.push(
      inArray(memoryV2ActivationLogs.conversationId, conversationIds),
    );
  }

  const rows = db
    .select({
      conversationId: memoryV2ActivationLogs.conversationId,
      messageId: memoryV2ActivationLogs.messageId,
      turn: memoryV2ActivationLogs.turn,
      conceptsJson: memoryV2ActivationLogs.conceptsJson,
      configJson: memoryV2ActivationLogs.configJson,
      createdAt: memoryV2ActivationLogs.createdAt,
    })
    .from(memoryV2ActivationLogs)
    .where(and(...filters))
    .orderBy(
      strategy === "random"
        ? sql`RANDOM()`
        : desc(memoryV2ActivationLogs.createdAt),
    )
    .limit(limit)
    .all();

  const turns: OracleTurn[] = [];
  for (const row of rows) {
    const messageId = row.messageId;
    if (messageId == null) continue;

    const anchor = db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .all();
    const anchorRow = anchor[0];
    if (!anchorRow) continue;

    let concepts: MemoryV2ConceptRowRecord[];
    let loggedConfig: MemoryV2ConfigSnapshot;
    try {
      concepts = JSON.parse(row.conceptsJson) as MemoryV2ConceptRowRecord[];
      loggedConfig = JSON.parse(row.configJson) as MemoryV2ConfigSnapshot;
    } catch {
      continue;
    }

    const seen = new Set<string>();
    const groundTruthSlugs: string[] = [];
    for (const concept of concepts) {
      if (!allowedStatuses.has(concept.status)) continue;
      if (pageExists && !pageExists(concept.slug)) continue;
      if (seen.has(concept.slug)) continue;
      seen.add(concept.slug);
      groundTruthSlugs.push(concept.slug);
    }
    if (groundTruthSlugs.length === 0) continue;

    turns.push({
      conversationId: row.conversationId,
      turn: row.turn,
      anchorMessageId: messageId,
      anchorCreatedAt: anchorRow.createdAt,
      groundTruthSlugs,
      loggedConfig,
      createdAt: row.createdAt,
    });
  }

  return turns;
}

import { eq } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import { areStatementsCoherent } from "./conflict-intent.js";
import {
  isConflictKindEligible,
  isStatementConflictEligible,
} from "./conflict-policy.js";
import { createOrUpdatePendingConflict } from "./conflict-store.js";
import { getDb, getSqlite, rawAll } from "./db.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { memoryItems } from "./schema.js";
import { clampUnitInterval } from "./validation.js";

const log = getLogger("memory-contradiction-checker");

const CONTRADICTION_LLM_TIMEOUT_MS = 15_000;

type Relationship =
  | "contradiction"
  | "update"
  | "complement"
  | "ambiguous_contradiction";

interface ClassifyResult {
  relationship: Relationship;
  explanation: string;
}

const CONTRADICTION_SYSTEM_PROMPT = `You are a memory consistency checker. Given two statements about the same subject, determine their relationship.

Classify the relationship as one of:
- "contradiction": The new statement directly contradicts the old statement. They cannot both be true at the same time. Example: "User prefers dark mode" vs "User prefers light mode".
- "update": The new statement provides updated or more specific information that supersedes the old statement, but does not contradict it. Example: "User works at Acme" vs "User works at Acme as a senior engineer".
- "complement": The statements are compatible and provide different, non-overlapping information. Both can coexist. Example: "User likes TypeScript" vs "User prefers functional programming".
- "ambiguous_contradiction": The statements appear to conflict, but there is not enough confidence to invalidate either statement without user clarification.

Be conservative: only classify as "contradiction" when the statements are genuinely incompatible. Prefer "complement" when in doubt.`;

/**
 * Check a newly extracted memory item against existing items for contradictions.
 * Searches for existing active items with similar subject/statement, then uses
 * LLM to classify the relationship and handle accordingly.
 */
export async function checkContradictions(newItemId: string): Promise<void> {
  const db = getDb();
  const newItem = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, newItemId))
    .get();

  if (!newItem || newItem.status !== "active") {
    log.debug(
      { newItemId },
      "Skipping contradiction check — item not found or not active",
    );
    return;
  }

  // Find existing active items with similar kind + subject
  const candidates = findSimilarItems(newItem);
  if (candidates.length === 0) {
    log.debug(
      { newItemId, subject: newItem.subject },
      "No similar items found for contradiction check",
    );
    return;
  }

  const provider = getConfiguredProvider();
  if (!provider) {
    log.debug("Configured provider unavailable for contradiction checking");
    return;
  }

  const config = getConfig();

  if (!isConflictKindEligible(newItem.kind, config.memory.conflicts)) {
    log.debug(
      { newItemId, kind: newItem.kind },
      "Skipping contradiction check — kind not eligible for conflicts",
    );
    return;
  }

  // Skip if the new item's statement is transient/non-durable
  if (
    !isStatementConflictEligible(
      newItem.kind,
      newItem.statement,
      config.memory.conflicts,
    )
  ) {
    log.debug(
      { newItemId, kind: newItem.kind },
      "Skipping contradiction check — statement is transient or non-durable",
    );
    return;
  }

  for (const existing of candidates) {
    // Skip candidate if its statement is transient/non-durable
    if (
      !isStatementConflictEligible(
        existing.kind,
        existing.statement,
        config.memory.conflicts,
      )
    ) {
      log.debug(
        { existingId: existing.id },
        "Skipping candidate — statement is transient or non-durable",
      );
      continue;
    }

    // Skip pairs with zero topical overlap — they are not real contradictions
    if (!areStatementsCoherent(existing.statement, newItem.statement)) {
      log.debug(
        { existingId: existing.id, newId: newItem.id },
        "Skipping candidate — zero statement overlap (incoherent pair)",
      );
      continue;
    }

    try {
      const result = await classifyRelationship(existing, newItem);
      const mutated = handleRelationship(result, existing, newItem);
      // Only stop when the new item itself was actually invalidated (update case)
      // or gated (ambiguous_contradiction). For contradiction, the old item is
      // invalidated but the new item remains active and should continue to be
      // checked against remaining candidates. Skip the break when the transaction
      // detected stale data and performed no mutation.
      if (
        mutated &&
        (result.relationship === "update" ||
          result.relationship === "ambiguous_contradiction")
      )
        break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err: message, newItemId, existingId: existing.id },
        "Contradiction classification failed for pair",
      );
    }
  }
}

interface MemoryItemRow {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  status: string;
  confidence: number;
  importance: number | null;
  scopeId: string;
  lastSeenAt: number;
}

/**
 * Find existing active items that are similar to the given item.
 * Uses LIKE queries on subject and keyword overlap on statement.
 */
function findSimilarItems(item: MemoryItemRow): MemoryItemRow[] {
  // Extract significant words from subject for LIKE matching
  const subjectWords = item.subject
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/g)
    .filter((w) => w.length >= 3);

  // Extract significant words from statement for additional matching
  const statementWords = item.statement
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/g)
    .filter((w) => w.length >= 3);

  if (subjectWords.length === 0 && statementWords.length === 0) return [];

  // Build LIKE clauses for subject similarity
  const likeClauses: string[] = [];
  for (const word of subjectWords) {
    const escaped = escapeSqlLike(word);
    likeClauses.push(`LOWER(subject) LIKE '%${escaped}%'`);
  }

  // Also match on statement keywords (top 5 longest words for specificity)
  const topStatementWords = statementWords
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
  for (const word of topStatementWords) {
    const escaped = escapeSqlLike(word);
    likeClauses.push(`LOWER(statement) LIKE '%${escaped}%'`);
  }

  if (likeClauses.length === 0) return [];

  const sqlQuery = `
    SELECT id, kind, subject, statement, status, confidence, importance, scope_id, last_seen_at
    FROM memory_items
    WHERE status = 'active'
      AND invalid_at IS NULL
      AND kind = ?
      AND id <> ?
      AND scope_id = ?
      AND (${likeClauses.join(" OR ")})
    ORDER BY last_seen_at DESC
    LIMIT 10
  `;

  try {
    interface SimilarItemRow {
      id: string;
      kind: string;
      subject: string;
      statement: string;
      status: string;
      confidence: number;
      importance: number | null;
      scope_id: string;
      last_seen_at: number;
    }
    const rows = rawAll<SimilarItemRow>(
      sqlQuery,
      item.kind,
      item.id,
      item.scopeId,
    );

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      statement: row.statement,
      status: row.status,
      confidence: row.confidence,
      importance: row.importance,
      scopeId: row.scope_id,
      lastSeenAt: row.last_seen_at,
    }));
  } catch (err) {
    log.warn({ err }, "Failed to search for similar memory items");
    return [];
  }
}

/**
 * Use LLM to classify the relationship between two memory items.
 */
async function classifyRelationship(
  existingItem: MemoryItemRow,
  newItem: MemoryItemRow,
): Promise<ClassifyResult> {
  const provider = getConfiguredProvider()!;

  const userContent = [
    `Subject: ${newItem.subject}`,
    "",
    `Old statement: ${existingItem.statement}`,
    `New statement: ${newItem.statement}`,
  ].join("\n");

  const { signal, cleanup } = createTimeout(CONTRADICTION_LLM_TIMEOUT_MS);
  try {
    const response = await provider.sendMessage(
      [userMessage(userContent)],
      [
        {
          name: "classify_relationship",
          description:
            "Classify the relationship between two memory statements",
          input_schema: {
            type: "object" as const,
            properties: {
              relationship: {
                type: "string",
                enum: [
                  "contradiction",
                  "update",
                  "complement",
                  "ambiguous_contradiction",
                ],
                description:
                  "The relationship between the old and new statements",
              },
              explanation: {
                type: "string",
                description:
                  "Brief explanation of why this relationship was chosen",
              },
            },
            required: ["relationship", "explanation"],
          },
        },
      ],
      CONTRADICTION_SYSTEM_PROMPT,
      {
        config: {
          modelIntent: "latency-optimized",
          max_tokens: 256,
          tool_choice: { type: "tool" as const, name: "classify_relationship" },
        },
        signal,
      },
    );
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      throw new Error("No tool_use block in contradiction check response");
    }

    const input = toolBlock.input as {
      relationship?: string;
      explanation?: string;
    };
    const relationship = input.relationship as Relationship;
    if (
      ![
        "contradiction",
        "update",
        "complement",
        "ambiguous_contradiction",
      ].includes(relationship)
    ) {
      throw new Error(`Invalid relationship type: ${relationship}`);
    }

    return {
      relationship,
      explanation: truncate(String(input.explanation ?? ""), 500, ""),
    };
  } finally {
    cleanup();
  }
}

/**
 * Handle the classified relationship between an existing and new memory item.
 *
 * Wrapped in a SQLite transaction so that multi-row mutations (e.g. invalidating
 * the old item AND setting validFrom on the new one) are atomic. The transaction
 * also re-verifies both items are still active before mutating, preventing a
 * TOCTOU race when multiple workers process contradictions concurrently.
 */
function handleRelationship(
  result: ClassifyResult,
  existingItem: MemoryItemRow,
  newItem: MemoryItemRow,
): boolean {
  if (result.relationship === "complement") {
    log.debug(
      {
        existingId: existingItem.id,
        newId: newItem.id,
        explanation: result.explanation,
      },
      "Complement detected — keeping both items",
    );
    return false;
  }

  return getSqlite()
    .transaction(() => {
      const db = getDb();
      const now = Date.now();

      // Re-check both items inside the transaction to guard against concurrent mutations
      const freshExisting = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, existingItem.id))
        .get();
      const freshNew = db
        .select()
        .from(memoryItems)
        .where(eq(memoryItems.id, newItem.id))
        .get();

      if (
        !freshExisting ||
        freshExisting.status !== "active" ||
        freshExisting.invalidAt != null
      ) {
        log.debug(
          { existingId: existingItem.id },
          "Existing item no longer active — skipping",
        );
        return false;
      }
      if (
        !freshNew ||
        (freshNew.status !== "active" &&
          result.relationship !== "ambiguous_contradiction") ||
        freshNew.invalidAt != null
      ) {
        log.debug(
          { newId: newItem.id },
          "New item no longer active — skipping",
        );
        return false;
      }

      switch (result.relationship) {
        case "contradiction": {
          log.info(
            {
              existingId: existingItem.id,
              newId: newItem.id,
              explanation: result.explanation,
            },
            "Contradiction detected — invalidating old item",
          );
          db.update(memoryItems)
            .set({ invalidAt: now })
            .where(eq(memoryItems.id, existingItem.id))
            .run();
          db.update(memoryItems)
            .set({ validFrom: now })
            .where(eq(memoryItems.id, newItem.id))
            .run();
          return true;
        }
        case "update": {
          log.debug(
            {
              existingId: existingItem.id,
              newId: newItem.id,
              explanation: result.explanation,
            },
            "Update detected — merging into existing item",
          );
          db.update(memoryItems)
            .set({
              statement: newItem.statement,
              lastSeenAt: Math.max(
                freshExisting.lastSeenAt,
                freshNew!.lastSeenAt,
              ),
              confidence: clampUnitInterval(
                Math.max(freshExisting.confidence, freshNew!.confidence),
              ),
            })
            .where(eq(memoryItems.id, existingItem.id))
            .run();
          enqueueMemoryJob("embed_item", { itemId: existingItem.id });
          db.update(memoryItems)
            .set({ invalidAt: now })
            .where(eq(memoryItems.id, newItem.id))
            .run();
          return true;
        }
        case "ambiguous_contradiction": {
          log.info(
            {
              existingId: existingItem.id,
              newId: newItem.id,
              explanation: result.explanation,
            },
            "Ambiguous contradiction detected — gating candidate pending clarification",
          );
          db.update(memoryItems)
            .set({ status: "pending_clarification" })
            .where(eq(memoryItems.id, newItem.id))
            .run();
          createOrUpdatePendingConflict({
            scopeId: newItem.scopeId,
            existingItemId: existingItem.id,
            candidateItemId: newItem.id,
            relationship: "ambiguous_contradiction",
            clarificationQuestion: buildClarificationQuestion(
              existingItem.statement,
              newItem.statement,
            ),
          });
          return true;
        }
        default:
          return false;
      }
    })
    .immediate();
}

function escapeSqlLike(s: string): string {
  return s.replace(/'/g, "''").replace(/%/g, "").replace(/_/g, "");
}

function buildClarificationQuestion(
  existingStatement: string,
  candidateStatement: string,
): string {
  const normalize = (input: string): string =>
    truncate(input.replace(/\s+/g, " ").trim(), 180, "");
  return `Pending conflict: "${normalize(
    existingStatement,
  )}" vs "${normalize(candidateStatement)}"`;
}

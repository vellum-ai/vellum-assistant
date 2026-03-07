import { and, eq, ne } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { AssistantConfig } from "../../config/types.js";
import { getDb } from "../../memory/db.js";
import {
  getMemoryBackendStatus,
  logMemoryEmbeddingWarning,
} from "../../memory/embedding-backend.js";
import { computeMemoryFingerprint } from "../../memory/fingerprint.js";
import { formatRecallText } from "../../memory/format-recall.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import {
  collectAndMergeCandidates,
  embedWithRetry,
} from "../../memory/retriever.js";
import { memoryItems } from "../../memory/schema.js";
import type { ScopePolicyOverride } from "../../memory/search/types.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type { ToolExecutionResult } from "../types.js";

const log = getLogger("memory-tools");

// ── memory_save ──────────────────────────────────────────────────────

export async function handleMemorySave(
  args: Record<string, unknown>,
  _config: AssistantConfig,
  conversationId: string,
  messageId: string | undefined,
  scopeId: string = "default",
): Promise<ToolExecutionResult> {
  const statement = args.statement;
  if (typeof statement !== "string" || statement.trim().length === 0) {
    return {
      content: "Error: statement is required and must be a non-empty string",
      isError: true,
    };
  }

  const kind = args.kind;
  const validKinds = new Set([
    "preference",
    "fact",
    "decision",
    "profile",
    "relationship",
    "event",
    "opinion",
    "instruction",
    "style",
    "playbook",
    "learning",
  ]);
  if (typeof kind !== "string" || !validKinds.has(kind)) {
    return {
      content: `Error: kind is required and must be one of: ${[
        ...validKinds,
      ].join(", ")}`,
      isError: true,
    };
  }

  const subject =
    typeof args.subject === "string" && args.subject.trim().length > 0
      ? truncate(args.subject.trim(), 80, "")
      : inferSubjectFromStatement(statement.trim());

  try {
    const db = getDb();
    const id = uuid();
    const now = Date.now();
    const trimmedStatement = truncate(statement.trim(), 500, "");

    const fingerprint = computeMemoryFingerprint(
      scopeId,
      kind,
      subject,
      trimmedStatement,
    );

    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.fingerprint, fingerprint),
          eq(memoryItems.scopeId, scopeId),
          ne(memoryItems.status, "deleted"),
        ),
      )
      .get();

    if (existing) {
      db.update(memoryItems)
        .set({
          status: "active",
          importance: 0.8,
          lastSeenAt: now,
          verificationState: "user_confirmed",
        })
        .where(eq(memoryItems.id, existing.id))
        .run();

      enqueueMemoryJob("embed_item", { itemId: existing.id });
      return {
        content: `Memory already exists (ID: ${existing.id}). Updated and refreshed.`,
        isError: false,
      };
    }

    db.insert(memoryItems)
      .values({
        id,
        kind,
        subject,
        statement: trimmedStatement,
        status: "active",
        confidence: 0.95, // explicit saves have high confidence
        importance: 0.8, // explicit saves are high importance
        fingerprint,
        verificationState: "user_confirmed",
        scopeId,
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      })
      .run();

    enqueueMemoryJob("embed_item", { itemId: id });

    log.debug(
      { id, kind, subject, conversationId, messageId },
      "Memory item saved via tool",
    );
    return {
      content: `Saved to memory (ID: ${id}).\nKind: ${kind}\nSubject: ${subject}\nStatement: ${trimmedStatement}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "memory_save failed");
    return { content: `Error: Failed to save memory: ${msg}`, isError: true };
  }
}

// ── memory_update ────────────────────────────────────────────────────

export async function handleMemoryUpdate(
  args: Record<string, unknown>,
  _config: AssistantConfig,
  scopeId: string = "default",
): Promise<ToolExecutionResult> {
  const rawMemoryId = args.memory_id;
  if (typeof rawMemoryId !== "string" || rawMemoryId.trim().length === 0) {
    return {
      content: "Error: memory_id is required and must be a non-empty string",
      isError: true,
    };
  }

  // Accept both bare IDs and typed IDs (e.g. "item:abc-123" -> "abc-123")
  const memoryId = stripTypedIdPrefix(rawMemoryId.trim());

  const statement = args.statement;
  if (typeof statement !== "string" || statement.trim().length === 0) {
    return {
      content: "Error: statement is required and must be a non-empty string",
      isError: true,
    };
  }

  try {
    const db = getDb();

    // Constrain lookup to the current scope so threads cannot mutate
    // memory items belonging to a different scope.
    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(eq(memoryItems.id, memoryId), eq(memoryItems.scopeId, scopeId)),
      )
      .get();

    if (!existing) {
      return {
        content: `Error: Memory item with ID "${memoryId}" not found`,
        isError: true,
      };
    }

    const now = Date.now();
    const trimmedStatement = truncate(statement.trim(), 500, "");

    const fingerprint = computeMemoryFingerprint(
      scopeId,
      existing.kind,
      existing.subject,
      trimmedStatement,
    );

    // Collision detection also constrained to the current scope.
    const collision = db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.fingerprint, fingerprint),
          eq(memoryItems.scopeId, scopeId),
          ne(memoryItems.status, "deleted"),
        ),
      )
      .get();
    if (collision && collision.id !== existing.id) {
      return {
        content: `Error: Another memory item (ID: ${collision.id}) already contains this statement. Use memory_recall to find it.`,
        isError: true,
      };
    }

    db.update(memoryItems)
      .set({
        statement: trimmedStatement,
        fingerprint,
        lastSeenAt: now,
        importance: 0.8,
        verificationState: "user_confirmed",
      })
      .where(eq(memoryItems.id, existing.id))
      .run();

    enqueueMemoryJob("embed_item", { itemId: existing.id });

    log.debug(
      { id: existing.id, kind: existing.kind },
      "Memory item updated via tool",
    );
    return {
      content: `Updated memory (ID: ${existing.id}).\nKind: ${existing.kind}\nSubject: ${existing.subject}\nNew statement: ${trimmedStatement}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, memoryId }, "memory_update failed");
    return { content: `Error: Failed to update memory: ${msg}`, isError: true };
  }
}

// ── memory_recall ────────────────────────────────────────────────────

export interface MemoryRecallToolResult {
  text: string;
  resultCount: number;
  degraded: boolean;
  items: Array<{ id: string; type: string; kind: string }>;
  sources: {
    lexical: number;
    semantic: number;
    recency: number;
    entity: number;
  };
}

export async function handleMemoryRecall(
  args: Record<string, unknown>,
  config: AssistantConfig,
  scopeId?: string,
  conversationId?: string,
): Promise<ToolExecutionResult> {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      content: "Error: query is required and must be a non-empty string",
      isError: true,
    };
  }

  const maxResults =
    typeof args.max_results === "number" && args.max_results > 0
      ? Math.min(args.max_results, 50)
      : 10;

  const scope =
    typeof args.scope === "string" && args.scope.trim().length > 0
      ? args.scope.trim()
      : "default";

  // Scope policy: "conversation" means strict (only that scope),
  // anything else allows fallback to the default scope.
  const scopePolicyOverride: ScopePolicyOverride | undefined = scopeId
    ? {
        scopeId,
        fallbackToDefault: scope !== "conversation",
      }
    : undefined;

  try {
    const trimmedQuery = query.trim();

    // Generate embedding vector (graceful degradation if unavailable)
    let queryVector: number[] | null = null;
    let provider: string | undefined;
    let model: string | undefined;
    let degraded = false;

    const backendStatus = getMemoryBackendStatus(config);
    if (backendStatus.provider) {
      try {
        const embedded = await embedWithRetry(config, [trimmedQuery]);
        queryVector = embedded.vectors[0] ?? null;
        provider = embedded.provider;
        model = embedded.model;
      } catch (err) {
        logMemoryEmbeddingWarning(err, "query");
        degraded = !!config.memory.embeddings.required;
      }
    } else {
      degraded = backendStatus.degraded;
    }

    // Run the full retrieval pipeline with all sources enabled
    const collected = await collectAndMergeCandidates(trimmedQuery, config, {
      queryVector,
      provider,
      model,
      conversationId,
      scopeId,
      scopePolicyOverride,
    });

    if (collected.semanticSearchFailed) {
      degraded = true;
    }

    const candidates = collected.merged.slice(0, maxResults);

    if (candidates.length === 0) {
      const result: MemoryRecallToolResult = {
        text: "No matching memories found.",
        resultCount: 0,
        degraded,
        items: [],
        sources: {
          lexical: 0,
          semantic: 0,
          recency: 0,
          entity: 0,
        },
      };
      return {
        content: JSON.stringify(result),
        isError: false,
      };
    }

    // Format candidates into readable text using the shared formatter
    const formatted = formatRecallText(candidates, {
      format: config.memory.retrieval.injectionFormat,
      maxTokens: config.memory.retrieval.maxInjectTokens,
    });

    const items = formatted.selected.map((c) => ({
      id: c.id,
      type: c.type,
      kind: c.kind,
    }));

    const result: MemoryRecallToolResult = {
      text: formatted.text,
      resultCount: formatted.selected.length,
      degraded,
      items,
      sources: {
        lexical: collected.lexical.length,
        semantic: collected.semantic.length,
        recency: collected.recency.length,
        entity: collected.entity.length,
      },
    };

    return {
      content: JSON.stringify(result),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, query }, "memory_recall failed");
    return {
      content: `Error: Memory recall failed: ${msg}`,
      isError: true,
    };
  }
}

// ── memory_delete ────────────────────────────────────────────────────

export async function handleMemoryDelete(
  args: Record<string, unknown>,
  _config: AssistantConfig,
  scopeId: string = "default",
): Promise<ToolExecutionResult> {
  const rawMemoryId = args.memory_id;
  if (typeof rawMemoryId !== "string" || rawMemoryId.trim().length === 0) {
    return {
      content: "Error: memory_id is required and must be a non-empty string",
      isError: true,
    };
  }

  const memoryId = stripTypedIdPrefix(rawMemoryId.trim());

  try {
    const db = getDb();

    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(eq(memoryItems.id, memoryId), eq(memoryItems.scopeId, scopeId)),
      )
      .get();

    if (!existing) {
      return {
        content: `Error: Memory item with ID "${memoryId}" not found`,
        isError: true,
      };
    }

    if (existing.status === "deleted") {
      return {
        content: `Memory item (ID: ${memoryId}) was already deleted.`,
        isError: false,
      };
    }

    db.update(memoryItems)
      .set({
        status: "deleted",
        lastSeenAt: Date.now(),
      })
      .where(eq(memoryItems.id, existing.id))
      .run();

    log.debug(
      { id: existing.id, kind: existing.kind },
      "Memory item deleted via tool",
    );
    return {
      content: `Deleted memory (ID: ${existing.id}).\nKind: ${existing.kind}\nSubject: ${existing.subject}\nStatement: ${existing.statement}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, memoryId }, "memory_delete failed");
    return { content: `Error: Failed to delete memory: ${msg}`, isError: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function inferSubjectFromStatement(statement: string): string {
  // Take first few words as a subject label
  const words = statement.split(/\s+/).slice(0, 6).join(" ");
  return truncate(words, 80, "");
}

/**
 * Strip a typed ID prefix (e.g. "item:abc-123" -> "abc-123") so that IDs
 * copied from memory_recall output work in memory_update.
 */
function stripTypedIdPrefix(id: string): string {
  const match = id.match(/^(?:item|segment|summary):(.+)$/);
  return match ? match[1] : id;
}

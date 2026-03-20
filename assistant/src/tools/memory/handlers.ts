import { buildArchiveRecall } from "../../memory/archive-recall.js";
import { insertObservation } from "../../memory/archive-store.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type { ToolExecutionResult } from "../types.js";

const log = getLogger("memory-tools");

// ── memory_save ──────────────────────────────────────────────────────

export async function handleMemorySave(
  args: Record<string, unknown>,
  _config: unknown,
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

  const rawKind = args.kind;
  const validKinds = new Set([
    "identity",
    "preference",
    "project",
    "decision",
    "constraint",
    "event",
  ]);
  if (typeof rawKind !== "string") {
    return {
      content: `Error: kind is required and must be one of: ${[
        ...validKinds,
      ].join(", ")}`,
      isError: true,
    };
  }
  const kind = rawKind;
  if (!validKinds.has(kind)) {
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
    const trimmedStatement = truncate(statement.trim(), 500, "");
    const content = `[${kind}] ${subject}: ${trimmedStatement}`;

    const result = insertObservation({
      conversationId,
      messageId: messageId ?? null,
      role: "user",
      content,
      scopeId,
      modality: "text",
      source: "tool:memory_save",
    });

    log.debug(
      {
        observationId: result.observationId,
        chunkId: result.chunkId,
        kind,
        subject,
        conversationId,
        messageId,
      },
      "Memory saved via simplified system",
    );

    return {
      content: `Saved to memory (ID: ${result.observationId}).\nKind: ${kind}\nSubject: ${subject}\nStatement: ${trimmedStatement}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "memory_save failed");
    return { content: `Error: Failed to save memory: ${msg}`, isError: true };
  }
}

// ── memory_recall ────────────────────────────────────────────────────

export interface MemoryRecallToolResult {
  text: string;
  resultCount: number;
  degraded: boolean;
  items: Array<{ id: string; type: string; kind: string }>;
  sources: {
    semantic: number;
    recency: number;
  };
}

export async function handleMemoryRecall(
  args: Record<string, unknown>,
  _config: unknown,
  scopeId?: string,
  _conversationId?: string,
): Promise<ToolExecutionResult> {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      content: "Error: query is required and must be a non-empty string",
      isError: true,
    };
  }

  return handleSimplifiedMemoryRecall(query.trim(), scopeId ?? "default");
}

// ── Simplified memory helpers ────────────────────────────────────────

/**
 * Recall memories using the simplified archive recall path.
 */
function handleSimplifiedMemoryRecall(
  query: string,
  scopeId: string,
): ToolExecutionResult {
  try {
    const recallResult = buildArchiveRecall(scopeId, query);

    if (recallResult.bullets.length === 0) {
      return {
        content: JSON.stringify({
          text: "No matching memories found.",
          resultCount: 0,
          degraded: false,
          items: [],
          sources: { semantic: 0, recency: 0 },
        }),
        isError: false,
      };
    }

    const items = recallResult.bullets.map((b) => ({
      id: b.sourceId,
      type: b.source,
      kind: b.source,
    }));

    const result = {
      text: recallResult.text,
      resultCount: recallResult.bullets.length,
      degraded: false,
      items,
      sources: {
        semantic: recallResult.prefetchHitCount,
        recency: 0,
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

// ── Helpers ──────────────────────────────────────────────────────────

function inferSubjectFromStatement(statement: string): string {
  // Take first few words as a subject label
  const words = statement.split(/\s+/).slice(0, 6).join(" ");
  return truncate(words, 80, "");
}

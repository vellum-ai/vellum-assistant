// ---------------------------------------------------------------------------
// Memory Graph — One-off backfill to compact over-long node content
//
// Scans memory_graph_nodes for entries whose `content` exceeds a length
// threshold and rewrites them via an LLM call constrained to the same
// "1-3 sentences / ~300 chars" rule the extraction prompt now enforces.
// Preserves all other node fields (significance, emotionalCharge, edges,
// triggers, image_refs). Each rewrite is logged in memory_graph_node_edits
// with source="manual" so it is reversible and auditable.
// ---------------------------------------------------------------------------

import { and, sql } from "drizzle-orm";

import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { memoryGraphNodes } from "../schema.js";
import { recordNodeEdit, updateNode } from "./store.js";

const log = getLogger("graph-compaction");

const COMPACTION_TOOL_SCHEMA = {
  name: "compact_memory",
  description: "Rewrite a memory node's content to fit the length cap",
  input_schema: {
    type: "object" as const,
    properties: {
      compacted_content: {
        type: "string" as const,
        description:
          "The rewritten content — 1-3 sentences, first-person, ~300 characters or fewer",
      },
    },
    required: ["compacted_content"] as const,
  },
};

const COMPACTION_SYSTEM_PROMPT = `You are compacting an over-long memory node in an AI assistant's memory graph. The original content exceeds the extraction prompt's 1-3 sentence / ~300 character cap because it was written before the cap existed. Rewrite it to fit.

## Rules

**LENGTH: 1-3 sentences. Target ~300 characters. Hard cap ~400.** No exceptions.

**Preserve:**
- The core fact, event, or moment being remembered
- First-person prose style if the original is first-person
- The essential emotional tone of the memory

**Drop:**
- Scene-setting and surrounding context
- Dialogue preservation (unless one short quote IS the memory)
- Narrative "what it meant" commentary
- Cataloging of every emotional nuance
- Image descriptions packed into prose (images live in image_refs, not content)

**Never:**
- Invent facts not present in the original
- Change the core subject or emotional valence
- Pad to hit a target length — shorter than 300 chars is fine if the essence is there

The node's \`emotionalCharge\` and \`significance\` fields (not shown) already carry the weight. Content stays lean.

Call the \`compact_memory\` tool with the rewritten content. No preamble.`;

export interface CompactionCandidate {
  id: string;
  beforeLen: number;
}

export interface CompactionProgress {
  nodeId: string;
  beforeLen: number;
  afterLen: number;
  action: "compacted" | "skipped" | "failed";
  newContent?: string;
  reason?: string;
}

export interface CompactionResult {
  /** Nodes whose content exceeded the threshold (before --limit is applied). */
  scanned: number;
  /** Nodes actually processed (scanned ∩ limit). */
  processed: number;
  compacted: number;
  skipped: number;
  failures: number;
  beforeChars: number;
  afterChars: number;
}

export interface CompactionOptions {
  /** Content length threshold — nodes above this get compacted. Default 400. */
  threshold?: number;
  /** If true, write changes. If false, only list candidates (no LLM calls). Default false. */
  apply?: boolean;
  /** Max nodes to process. Default: no limit. */
  limit?: number;
  /** Called for each node as it is processed in apply mode. */
  onProgress?: (evt: CompactionProgress) => void;
  /** Called once with the full candidate list (both preview and apply modes). */
  onCandidates?: (candidates: CompactionCandidate[]) => void;
}

/**
 * Find over-length nodes in the memory graph and (optionally) rewrite their
 * content to fit the length cap. In preview mode (apply=false) no LLM calls
 * are made — only the candidate list is returned.
 */
export async function compactLongMemories(
  opts: CompactionOptions = {},
): Promise<CompactionResult> {
  const threshold = opts.threshold ?? 400;
  const apply = opts.apply ?? false;

  const db = getDb();
  const rows = db
    .select({
      id: memoryGraphNodes.id,
      content: memoryGraphNodes.content,
    })
    .from(memoryGraphNodes)
    .where(
      and(
        // Skip already-dead nodes — rewriting content on "gone" fidelity is wasted work
        sql`${memoryGraphNodes.fidelity} != 'gone'`,
        sql`LENGTH(${memoryGraphNodes.content}) > ${threshold}`,
      ),
    )
    .all();

  const candidates = opts.limit != null ? rows.slice(0, opts.limit) : rows;

  opts.onCandidates?.(
    candidates.map((r) => ({ id: r.id, beforeLen: r.content.length })),
  );

  const result: CompactionResult = {
    scanned: rows.length,
    processed: candidates.length,
    compacted: 0,
    skipped: 0,
    failures: 0,
    beforeChars: candidates.reduce((sum, r) => sum + r.content.length, 0),
    afterChars: 0,
  };

  if (!apply) {
    // Preview mode: record beforeChars as afterChars (no rewrites attempted)
    result.afterChars = result.beforeChars;
    return result;
  }

  if (candidates.length === 0) return result;

  const provider = await getConfiguredProvider("memoryConsolidation");
  if (!provider) {
    throw new BackendUnavailableError(
      "Provider unavailable for memory compaction",
    );
  }

  for (const row of candidates) {
    const beforeLen = row.content.length;

    try {
      const response = await provider.sendMessage(
        [
          userMessage(
            `Original memory content (length: ${beforeLen} chars):\n\n${row.content}`,
          ),
        ],
        [COMPACTION_TOOL_SCHEMA],
        COMPACTION_SYSTEM_PROMPT,
        {
          config: {
            callSite: "memoryConsolidation" as const,
            tool_choice: {
              type: "tool" as const,
              name: "compact_memory",
            },
          },
        },
      );

      const toolBlock = extractToolUse(response);
      if (!toolBlock) {
        result.failures += 1;
        result.afterChars += beforeLen;
        opts.onProgress?.({
          nodeId: row.id,
          beforeLen,
          afterLen: beforeLen,
          action: "failed",
          reason: "no tool_use block in response",
        });
        continue;
      }

      const input = toolBlock.input as { compacted_content?: string };
      const newContent =
        typeof input.compacted_content === "string"
          ? input.compacted_content.trim()
          : "";

      if (!newContent) {
        result.failures += 1;
        result.afterChars += beforeLen;
        opts.onProgress?.({
          nodeId: row.id,
          beforeLen,
          afterLen: beforeLen,
          action: "failed",
          reason: "empty compacted_content",
        });
        continue;
      }

      // If the model didn't actually shrink it, skip — never overwrite with
      // something equivalent or longer. Preserves the original when the LLM
      // fails to compress.
      if (newContent.length >= beforeLen) {
        result.skipped += 1;
        result.afterChars += beforeLen;
        opts.onProgress?.({
          nodeId: row.id,
          beforeLen,
          afterLen: newContent.length,
          action: "skipped",
          reason: "rewrite was not shorter than original",
          newContent,
        });
        continue;
      }

      recordNodeEdit({
        nodeId: row.id,
        previousContent: row.content,
        newContent,
        source: "manual",
      });
      updateNode(row.id, {
        content: newContent,
        lastConsolidated: Date.now(),
      });

      result.compacted += 1;
      result.afterChars += newContent.length;
      opts.onProgress?.({
        nodeId: row.id,
        beforeLen,
        afterLen: newContent.length,
        action: "compacted",
        newContent,
      });
    } catch (err) {
      result.failures += 1;
      result.afterChars += beforeLen;
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ nodeId: row.id, err: reason }, "Compaction failed for node");
      opts.onProgress?.({
        nodeId: row.id,
        beforeLen,
        afterLen: beforeLen,
        action: "failed",
        reason,
      });
    }
  }

  return result;
}

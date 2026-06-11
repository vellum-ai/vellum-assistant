// ---------------------------------------------------------------------------
// Memory Graph — Pattern detection
//
// Scans nodes for recurring themes and creates meta-nodes that capture
// patterns the assistant has noticed. E.g., 5 separate mentions of being
// tired → meta-node "User has been consistently tired over the past week."
//
// Also detects behavioral patterns in the assistant's own actions.
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { AssistantConfig } from "../../config/types.js";
import { runOneShotLLM } from "../../providers/one-shot-llm.js";
import { userMessage } from "../../providers/provider-send-message.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { createEdge, createNode, queryNodes } from "./store.js";

const log = getLogger("graph-pattern-scan");

/**
 * Pattern-scan tool input. Encodes what the previous manual
 * `toolBlock.input as {...}` cast assumed. `patterns` is the array the loop
 * iterates; each element is dropped (`continue`) downstream if it has fewer
 * than 3 valid source nodes, so the schema only needs to guarantee the
 * iterated fields exist with the right types. `partOfStory` stays optional.
 */
const PatternScanResultSchema = z.object({
  patterns: z
    .array(
      z.object({
        content: z.string(),
        type: z.string(),
        significance: z.number(),
        source_node_ids: z.array(z.string()),
        partOfStory: z.string().optional(),
      }),
    )
    .optional(),
});

/** Generous timeout for the pattern-scan background batch call. */
const PATTERN_SCAN_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Pattern scan prompt
// ---------------------------------------------------------------------------

function buildPatternScanPrompt(
  nodes: Array<{ id: string; type: string; content: string; created: number }>,
): string {
  const nodeList = nodes
    .map((n) => {
      const age = Math.floor((Date.now() - n.created) / (1000 * 60 * 60 * 24));
      return `  [${n.id}] type=${n.type} age=${age}d\n    ${n.content}`;
    })
    .join("\n\n");

  return `You are analyzing a random sample of an AI assistant's memory graph for recurring patterns, themes, and meta-observations.

## Your Tasks

1. **Detect recurring themes**: Look for topics, emotions, or situations that appear across 3+ nodes. Create a meta-node that captures the pattern itself — not just a summary, but an observation about the pattern.
   - Example: "I notice that user mentions being tired in at least 5 separate conversations over the past two weeks. This isn't isolated — it's a pattern worth monitoring."
   - Example: "There's a recurring theme of user starting ambitious projects late at night. Three separate memories mention work sessions starting after midnight."

2. **Detect behavioral patterns**: Look for patterns in the assistant's own behavior across memories.
   - Example: "I tend to over-commit to solving problems in the moment rather than flagging them for later."

3. **Avoid trivial patterns**: Don't create meta-nodes for things that are obvious from single memories. The pattern must emerge from MULTIPLE memories taken together.

## Constraints

- Write meta-node content in first person
- Type should be "behavioral" (for assistant patterns) or "narrative" (for observed user/relationship patterns)
- Set significance based on how actionable or important the pattern is
- Create "part-of" edges from source nodes to the new pattern node
- Only create patterns you're genuinely confident about — 3+ supporting nodes minimum

## Memory Sample

${nodeList}

Use the detect_patterns tool to output any patterns found.`;
}

const PATTERN_TOOL_SCHEMA = {
  name: "detect_patterns",
  description: "Output detected patterns from the memory sample",
  input_schema: {
    type: "object" as const,
    properties: {
      patterns: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            content: {
              type: "string" as const,
              description: "First-person prose describing the pattern",
            },
            type: {
              type: "string" as const,
              enum: ["behavioral", "narrative"],
            },
            significance: { type: "number" as const },
            source_node_ids: {
              type: "array" as const,
              items: { type: "string" as const },
              description:
                "IDs of nodes that support this pattern (3+ required)",
            },
            partOfStory: {
              type: "string" as const,
              description: "Optional narrative arc name",
            },
          },
          required: [
            "content",
            "type",
            "significance",
            "source_node_ids",
          ] as const,
        },
      },
    },
    required: ["patterns"] as const,
  },
};

// ---------------------------------------------------------------------------
// Run pattern scan
// ---------------------------------------------------------------------------

export interface PatternScanResult {
  patternsDetected: number;
  edgesCreated: number;
  latencyMs: number;
}

export async function runPatternScan(
  scopeId: string = "default",
  _config: AssistantConfig,
): Promise<PatternScanResult> {
  const start = Date.now();
  const result: PatternScanResult = {
    patternsDetected: 0,
    edgesCreated: 0,
    latencyMs: 0,
  };

  // Sample: take all nodes (for a graph of ~1000, this is manageable)
  // For larger graphs, we'd sample more selectively
  const allNodes = queryNodes({
    scopeId,
    fidelityNot: ["gone"],
    limit: 200,
  });

  if (allNodes.length < 10) {
    log.info("Too few nodes for pattern scan");
    result.latencyMs = Date.now() - start;
    return result;
  }

  const systemPrompt = buildPatternScanPrompt(
    allNodes.map((n) => ({
      id: n.id,
      type: n.type,
      content: n.content,
      created: n.created,
    })),
  );

  // `onUnavailable: "throw"` preserves the prior BackendUnavailableError
  // semantics for the no-provider case.
  const llmResult = await runOneShotLLM(
    "patternScan",
    [
      userMessage(
        "Analyze this memory sample for recurring patterns. Only report patterns you're confident about.",
      ),
    ],
    {
      tools: [PATTERN_TOOL_SCHEMA],
      toolChoice: "detect_patterns",
      schema: PatternScanResultSchema,
      systemPrompt,
      timeoutMs: PATTERN_SCAN_TIMEOUT_MS,
      onUnavailable: "throw",
    },
  );

  if (llmResult.status !== "ok") {
    // Required-job semantics: pattern scan runs as the `graph_pattern_scan`
    // memory job, and `jobs-worker.ts` calls `completeMemoryJob()` when this
    // returns normally — the maintenance checkpoint has already advanced at
    // enqueue time. A transient transport failure (timeout / provider error)
    // must NOT return an empty result, or the worker marks the job COMPLETED
    // and the scan is silently skipped for a full interval. Re-throw
    // BackendUnavailableError so `classifyError` (memory/job-utils.ts) routes
    // it to defer/retry, matching `consolidateChunk` / `runGraphExtraction`
    // and the sweep job. Malformed model output (`tool_use_missing` /
    // `schema_mismatch`) is NOT transient — retrying won't help — so it keeps
    // degrading to "no patterns detected", the same empty result the old
    // `!toolBlock` path produced.
    if (
      llmResult.status === "failure" &&
      (llmResult.reason === "timeout" || llmResult.reason === "provider_error")
    ) {
      throw llmResult.error instanceof BackendUnavailableError
        ? llmResult.error
        : new BackendUnavailableError(
            `Pattern scan LLM call failed (${llmResult.reason})`,
          );
    }
    log.warn(
      { reason: llmResult.status === "failure" ? llmResult.reason : undefined },
      "Pattern scan produced no usable tool output",
    );
    result.latencyMs = Date.now() - start;
    return result;
  }

  const input = llmResult.data;

  const existingIds = new Set(allNodes.map((n) => n.id));
  const now = Date.now();

  for (const pattern of input.patterns ?? []) {
    // Validate: at least 3 source nodes that actually exist
    const validSources = pattern.source_node_ids.filter((id) =>
      existingIds.has(id),
    );
    if (validSources.length < 3) continue;

    const type =
      pattern.type === "behavioral"
        ? ("behavioral" as const)
        : ("narrative" as const);
    const sig = Math.max(0.3, Math.min(0.8, pattern.significance));

    const newNode = createNode({
      content: pattern.content,
      type,
      created: now,
      lastAccessed: now,
      lastConsolidated: now,
      eventDate: null,
      emotionalCharge: {
        valence: 0,
        intensity: 0.3,
        decayCurve: "linear",
        decayRate: 0.05,
        originalIntensity: 0.3,
      },
      fidelity: "clear",
      confidence: 0.7,
      significance: sig,
      stability: 14,
      reinforcementCount: 0,
      lastReinforced: now,
      sourceConversations: [],
      sourceType: "observed",
      narrativeRole: null,
      partOfStory: pattern.partOfStory ?? null,
      imageRefs: null,
      scopeId,
    });

    result.patternsDetected++;

    // Create part-of edges from source nodes to pattern node
    for (const sourceId of validSources) {
      try {
        createEdge({
          sourceNodeId: sourceId,
          targetNodeId: newNode.id,
          relationship: "part-of",
          weight: 0.7,
          created: now,
        });
        result.edgesCreated++;
      } catch {
        log.warn(
          { sourceId, patternId: newNode.id },
          "Failed to create pattern edge",
        );
      }
    }
  }

  result.latencyMs = Date.now() - start;

  log.info(
    {
      patternsDetected: result.patternsDetected,
      edgesCreated: result.edgesCreated,
      latencyMs: result.latencyMs,
    },
    "Pattern scan complete",
  );

  return result;
}

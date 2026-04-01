// ---------------------------------------------------------------------------
// Memory Graph — Retrieval pipeline
//
// Two modes:
// 1. Context load (conversation start) — full retrieval with re-ranking
// 2. Per-turn injection — lightweight embedding search for new memories
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../../config/types.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type { ContentBlock, ImageContent } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { embedWithRetry } from "../embed.js";
import { selectedBackendSupportsMultimodal } from "../embedding-backend.js";
import { searchGraphNodes } from "./graph-search.js";
import type { InContextTracker } from "./injection.js";
import {
  computeActivationSpread,
  computeEffectiveSignificance,
  computeRecencyBoost,
  computeTemporalBoost,
  PER_TURN_WEIGHTS,
  scoreCandidate,
} from "./scoring.js";
import { sampleSerendipity } from "./serendipity.js";
import { getEdgesForNode, getNodesByIds, queryNodes } from "./store.js";
import { getActiveTriggersByType } from "./store.js";
import {
  evaluateEventTriggers,
  evaluateSemanticTriggers,
  evaluateTemporalTriggers,
  type TriggeredResult,
} from "./triggers.js";
import type { MemoryEdge, ScoredNode } from "./types.js";

const log = getLogger("graph-retriever");

// ---------------------------------------------------------------------------
// LLM re-ranking + deduplication
// ---------------------------------------------------------------------------

const RERANK_TOOL = {
  name: "select_memories",
  description:
    "Select and order the best memories to load into context, removing duplicates",
  input_schema: {
    type: "object" as const,
    properties: {
      selected: {
        type: "array" as const,
        description:
          "Ordered list of item numbers to include (best first). Remove duplicates — keep only the richest version of each topic.",
        items: { type: "number" as const },
      },
    },
    required: ["selected"] as const,
  },
};

/**
 * LLM re-ranking pass: takes ~60 scored candidates, removes duplicates,
 * and selects the best ~40 for context injection. Falls back to the
 * original scored list on any failure.
 */
async function rerankAndDedup(
  candidates: ScoredNode[],
  maxNodes: number,
  _config: AssistantConfig,
): Promise<ScoredNode[]> {
  if (candidates.length <= maxNodes) return candidates;

  try {
    const provider = await getConfiguredProvider();
    if (!provider) return candidates.slice(0, maxNodes);

    // Compact listing for the LLM: numbered index + age + first 100 chars
    const now = Date.now();
    const listing = candidates
      .map((s, i) => {
        const ageDays = (now - s.node.created) / (1000 * 60 * 60 * 24);
        const age =
          ageDays < 1
            ? `${Math.floor(ageDays * 24)}h`
            : `${Math.floor(ageDays)}d`;
        const preview =
          s.node.content.length > 100
            ? s.node.content.slice(0, 100) + "…"
            : s.node.content;
        return `${i + 1}. (${age}) ${preview}`;
      })
      .join("\n");

    const response = await provider.sendMessage(
      [userMessage(listing)],
      [RERANK_TOOL],
      `You are selecting memories for an AI assistant's context at conversation start. You see ${candidates.length} candidate memories ranked by algorithmic score.

Your job:
1. REMOVE DUPLICATES: If multiple entries describe the same event/fact/topic, keep ONLY the most complete version. Be aggressive — even partial overlaps should be deduplicated.
2. SELECT the best ${maxNodes} memories for a well-rounded context. Prioritize:
   - Recency (recent events should be well-represented)
   - Diversity (don't load 5 memories about the same topic)
   - Importance (key relationship moments, active commitments, identity-defining events)
3. Return the IDs in order of importance (most important first).`,
      {
        config: {
          modelIntent: "quality-optimized" as const,
          tool_choice: { type: "tool" as const, name: "select_memories" },
          thinking: { type: "disabled" },
          temperature: 0,
        },
      },
    );

    const toolBlock = extractToolUse(response);
    if (!toolBlock) return candidates.slice(0, maxNodes);

    const input = toolBlock.input as { selected?: number[] };
    if (!input.selected?.length) return candidates.slice(0, maxNodes);

    // Rebuild scored list in the LLM's chosen order (1-indexed → 0-indexed)
    const reranked: ScoredNode[] = [];
    const seen = new Set<number>();
    for (const num of input.selected) {
      const idx = num - 1;
      if (idx >= 0 && idx < candidates.length && !seen.has(idx)) {
        reranked.push(candidates[idx]);
        seen.add(idx);
      }
    }

    if (reranked.length === 0) return candidates.slice(0, maxNodes);
    return reranked.slice(0, maxNodes);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "LLM rerank failed, using scored order",
    );
    return candidates.slice(0, maxNodes);
  }
}

// ---------------------------------------------------------------------------
// Per-turn dedup — lightweight duplicate removal with a fast model
// ---------------------------------------------------------------------------

const SELECT_ITEMS_TOOL = {
  name: "select_items",
  description:
    "Select the most relevant items after deduplication, ordered by relevance to the query",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array" as const,
        description:
          "Item numbers to keep (1-indexed), ordered by relevance to the query. Remove duplicates — when multiple entries describe the same event/fact, keep ONLY the richest version.",
        items: { type: "number" as const },
      },
    },
    required: ["items"] as const,
  },
};

/**
 * Fast dedup + rerank pass for per-turn injection. Uses a latency-optimized
 * model to remove duplicates and reorder by relevance to the user's query.
 * Falls back to score-based truncation on any failure.
 */
async function dedupForTurn(
  candidates: ScoredNode[],
  maxNodes: number,
  query: string,
): Promise<ScoredNode[]> {
  try {
    const provider = await getConfiguredProvider();
    if (!provider) return candidates.slice(0, maxNodes);

    const now = Date.now();
    const listing = candidates
      .map((s, i) => {
        const ageDays = (now - s.node.created) / (1000 * 60 * 60 * 24);
        const age =
          ageDays < 1
            ? `${Math.floor(ageDays * 24)}h`
            : `${Math.floor(ageDays)}d`;
        const preview =
          s.node.content.length > 150
            ? s.node.content.slice(0, 150) + "…"
            : s.node.content;
        return `${i + 1}. (${age}) ${preview}`;
      })
      .join("\n");

    const response = await provider.sendMessage(
      [userMessage(`query:\n${query}\n\nitems:\n\n${listing}`)],
      [SELECT_ITEMS_TOOL],
      `Dedupe + rerank the following numbered items. Pick the most relevant items to the query. Call the select_items tool.\n\nBe aggressive on dedup — when multiple items describe the same event, fact, or status, keep ONLY the richest version. But be generous on relevance — only cut items that are completely irrelevant to the query. If it's even tangentially related, keep it.`,
      {
        config: {
          modelIntent: "latency-optimized" as const,
          tool_choice: { type: "tool" as const, name: "select_items" },
          thinking: { type: "disabled" },
          temperature: 0,
        },
      },
    );

    const toolBlock = extractToolUse(response);
    if (!toolBlock) return candidates.slice(0, maxNodes);

    const input = toolBlock.input as { items?: number[] };
    if (!input.items?.length) return candidates.slice(0, maxNodes);

    const reranked: ScoredNode[] = [];
    const seen = new Set<number>();
    for (const num of input.items) {
      const idx = num - 1;
      if (idx >= 0 && idx < candidates.length && !seen.has(idx)) {
        reranked.push(candidates[idx]);
        seen.add(idx);
      }
    }

    return reranked.length > 0
      ? reranked.slice(0, maxNodes)
      : candidates.slice(0, maxNodes);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Per-turn dedup+rerank failed, using scored order",
    );
    return candidates.slice(0, maxNodes);
  }
}

// ---------------------------------------------------------------------------
// Context load — conversation start
// ---------------------------------------------------------------------------

export interface ContextLoadOpts {
  /** Scope for memory isolation. */
  scopeId: string;
  /** Recent conversation summaries (used as retrieval queries). */
  recentSummaries: string[];
  /** Embedding config. */
  config: AssistantConfig;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Number of serendipity slots (default 5). */
  serendipitySlots?: number;
  /** Maximum nodes to return (default 40). */
  maxNodes?: number;
}

export interface ContextLoadResult {
  nodes: ScoredNode[];
  serendipityNodes: ScoredNode[];
  triggeredNodes: TriggeredResult[];
  latencyMs: number;
}

/**
 * Full retrieval pipeline for conversation start. Budget: p90 < 2s.
 *
 * 1. Embed recent conversation summaries
 * 2. Hybrid retrieval from Qdrant
 * 3. Evaluate triggers (temporal + semantic + event)
 * 4. Activation spreading from triggered/top nodes
 * 5. Score all candidates
 * 6. Serendipity sampling
 * 7. Return top N
 */
export async function loadContextMemory(
  opts: ContextLoadOpts,
): Promise<ContextLoadResult> {
  const start = Date.now();
  const maxNodes = opts.maxNodes ?? 40;
  const serendipitySlots = opts.serendipitySlots ?? 10;
  const now = new Date();
  const nowMs = now.getTime();

  // 1. Embed recent conversation summaries as retrieval queries
  let queryVector: number[] | null = null;
  if (opts.recentSummaries.length > 0) {
    try {
      const queryText = opts.recentSummaries.join("\n\n");
      const truncated =
        queryText.length > 3000 ? queryText.slice(0, 3000) : queryText;
      const result = await embedWithRetry(opts.config, [truncated], {
        signal: opts.signal,
      });
      queryVector = result.vectors[0] ?? null;
    } catch (err) {
      log.warn({ err }, "Failed to embed summaries for context load");
    }
  }

  // 2. Hybrid retrieval from Qdrant (dense search on graph_node points)
  const semanticCandidateIds = new Map<string, number>(); // nodeId → score
  if (queryVector) {
    try {
      const results = await searchGraphNodes(queryVector, maxNodes * 3, [
        opts.scopeId,
      ]);
      for (const r of results) {
        semanticCandidateIds.set(r.nodeId, r.score);
      }
    } catch (err) {
      log.warn({ err }, "Qdrant search failed for context load");
    }
  }

  // Also include top-significance nodes as a fallback
  const topSignificance = queryNodes({
    scopeId: opts.scopeId,
    fidelityNot: ["gone"],
    limit: maxNodes,
  });
  for (const node of topSignificance) {
    if (!semanticCandidateIds.has(node.id)) {
      semanticCandidateIds.set(node.id, 0); // no semantic score, ranked by significance
    }
  }

  // Include recent nodes (last 7 days) so recency is always represented.
  // Exclude procedural nodes (capabilities) — they're auto-injected and
  // shouldn't compete on recency.
  const recentNodes = queryNodes({
    scopeId: opts.scopeId,
    fidelityNot: ["gone"],
    createdAfter: nowMs - 7 * 24 * 60 * 60 * 1000,
    limit: maxNodes,
  });
  for (const node of recentNodes) {
    if (node.type === "procedural") continue;
    if (!semanticCandidateIds.has(node.id)) {
      semanticCandidateIds.set(node.id, 0);
    }
  }

  // Hydrate all candidate nodes
  const allCandidateIds = [...semanticCandidateIds.keys()];
  const candidateNodes = getNodesByIds(allCandidateIds);
  const nodeMap = new Map(candidateNodes.map((n) => [n.id, n]));

  // 3. Evaluate triggers
  const temporalTriggers = getActiveTriggersByType("temporal", opts.scopeId);
  const semanticTriggers = getActiveTriggersByType("semantic", opts.scopeId);
  const eventTriggers = getActiveTriggersByType("event", opts.scopeId);

  const triggeredTemporal = evaluateTemporalTriggers(temporalTriggers, now);
  const triggeredSemantic = queryVector
    ? evaluateSemanticTriggers(semanticTriggers, queryVector)
    : [];
  const triggeredEvent = evaluateEventTriggers(eventTriggers, now);

  const allTriggered = [
    ...triggeredTemporal,
    ...triggeredSemantic,
    ...triggeredEvent,
  ];

  // Build trigger boost map (nodeId → max trigger boost)
  const triggerBoostMap = new Map<string, number>();
  for (const t of allTriggered) {
    const current = triggerBoostMap.get(t.trigger.nodeId) ?? 0;
    triggerBoostMap.set(t.trigger.nodeId, Math.max(current, t.boost));

    // Ensure triggered nodes are in the candidate set
    if (!nodeMap.has(t.trigger.nodeId)) {
      const node = getNodesByIds([t.trigger.nodeId])[0];
      if (node) {
        nodeMap.set(node.id, node);
        semanticCandidateIds.set(node.id, 0);
      }
    }
  }

  // 4. Activation spreading
  // Collect edges for all candidate nodes
  const allEdges: MemoryEdge[] = [];
  for (const id of nodeMap.keys()) {
    allEdges.push(...getEdgesForNode(id));
  }

  // Start spreading from top semantic hits + triggered nodes
  const spreadStartIds = [
    ...allTriggered.map((t) => t.trigger.nodeId),
    ...[...semanticCandidateIds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id),
  ];

  const activationBoosts = computeActivationSpread(spreadStartIds, allEdges, 2);

  // Hydrate any newly discovered nodes from activation spreading
  const newNodeIds = [...activationBoosts.keys()].filter(
    (id) => !nodeMap.has(id),
  );
  if (newNodeIds.length > 0) {
    const newNodes = getNodesByIds(newNodeIds);
    for (const node of newNodes) {
      nodeMap.set(node.id, node);
    }
  }

  // 5. Score all candidates
  const scored: ScoredNode[] = [];
  for (const [nodeId, node] of nodeMap) {
    if (node.fidelity === "gone") continue;

    const semanticSim = semanticCandidateIds.get(nodeId) ?? 0;
    const effectiveSig = computeEffectiveSignificance(node, nowMs);
    const temporal = computeTemporalBoost(node, now);
    const triggerBoost = triggerBoostMap.get(nodeId) ?? 0;
    const activation = activationBoosts.get(nodeId) ?? 0;

    // Normalize temporal boost from [-1,1] to [0,1]
    const normalizedTemporal = (temporal + 1) / 2;
    // Procedural nodes (capabilities) are auto-seeded — no recency boost
    const recency =
      node.type === "procedural" ? 0 : computeRecencyBoost(node, nowMs);

    scored.push(
      scoreCandidate(node, {
        semanticSimilarity: semanticSim,
        effectiveSignificance: effectiveSig,
        emotionalIntensity: node.emotionalCharge.intensity,
        temporalBoost: normalizedTemporal,
        recencyBoost: recency,
        triggerBoost,
        activationBoost: activation,
      }),
    );
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 6. Reserve slots for recent prospective nodes (commitments, tasks, plans).
  //    These MUST surface at conversation start regardless of score — if the user
  //    said "I have a doctor appointment tomorrow," Velissa must remember it.
  const PROSPECTIVE_RESERVE = 10;
  const recentProspective = queryNodes({
    scopeId: opts.scopeId,
    types: ["prospective"],
    fidelityNot: ["gone"],
    createdAfter: nowMs - 3 * 24 * 60 * 60 * 1000, // last 3 days
    limit: PROSPECTIVE_RESERVE,
  });

  // Filter out prospective nodes that have been superseded or resolved.
  // A "supersedes" or "resolved-by" edge targeting a node means its
  // content has been replaced by a newer memory — stop force-surfacing it.
  const unresolvedProspective = recentProspective.filter((node) => {
    const incoming = getEdgesForNode(node.id, "incoming");
    return !incoming.some(
      (e) =>
        e.relationship === "supersedes" || e.relationship === "resolved-by",
    );
  });

  // Score them so they have breakdowns, but they're guaranteed inclusion
  const prospectiveIds = new Set(unresolvedProspective.map((n) => n.id));
  const reservedNodes: ScoredNode[] = unresolvedProspective.map((node) => {
    const existing = scored.find((s) => s.node.id === node.id);
    if (existing) return existing;
    return scoreCandidate(node, {
      semanticSimilarity: 0,
      effectiveSignificance: computeEffectiveSignificance(node, nowMs),
      emotionalIntensity: node.emotionalCharge.intensity,
      temporalBoost: (computeTemporalBoost(node, now) + 1) / 2,
      recencyBoost: computeRecencyBoost(node, nowMs),
      triggerBoost: 0,
      activationBoost: 0,
    });
  });

  // Reserve slots for upcoming events (nodes with event dates in the future).
  // Like prospective reservation, these MUST surface — if the user said
  // "I have a flight Tuesday," the assistant must remember it regardless of score.
  const UPCOMING_RESERVE = 5;
  const upcomingEvents = queryNodes({
    scopeId: opts.scopeId,
    fidelityNot: ["gone"],
    hasEventDate: true,
    eventDateAfter: nowMs,
    eventDateBefore: nowMs + 30 * 24 * 60 * 60 * 1000, // next 30 days
    limit: 20, // Fetch extra candidates — post-sort by proximity below
  });

  // Sort by event date ascending so soonest events get reserved first
  // (queryNodes sorts by significance, which would drop a tomorrow-event
  // with low significance in favor of a 3-weeks-away high-significance one)
  upcomingEvents.sort((a, b) => (a.eventDate ?? 0) - (b.eventDate ?? 0));

  const unresolvedUpcoming = upcomingEvents
    .filter((node) => {
      if (prospectiveIds.has(node.id)) return false; // already reserved as prospective
      const incoming = getEdgesForNode(node.id, "incoming");
      return !incoming.some(
        (e) =>
          e.relationship === "supersedes" || e.relationship === "resolved-by",
      );
    })
    .slice(0, UPCOMING_RESERVE);

  const upcomingIds = new Set(unresolvedUpcoming.map((n) => n.id));
  const reservedUpcoming: ScoredNode[] = unresolvedUpcoming.map((node) => {
    const existing = scored.find((s) => s.node.id === node.id);
    if (existing) return existing;
    return scoreCandidate(node, {
      semanticSimilarity: 0,
      effectiveSignificance: computeEffectiveSignificance(node, nowMs),
      emotionalIntensity: node.emotionalCharge.intensity,
      temporalBoost: (computeTemporalBoost(node, now) + 1) / 2,
      recencyBoost: computeRecencyBoost(node, nowMs),
      triggerBoost: 0,
      activationBoost: 0,
    });
  });

  // Remove prospective and upcoming nodes from the main pool (they have reserved slots)
  const mainPool = scored.filter(
    (s) => !prospectiveIds.has(s.node.id) && !upcomingIds.has(s.node.id),
  );
  const mainSlots =
    maxNodes - serendipitySlots - reservedNodes.length - reservedUpcoming.length;

  // 7. LLM re-ranking on the main pool: dedup + select
  const reranked = await rerankAndDedup(
    mainPool.slice(0, 100),
    mainSlots,
    opts.config,
  );

  // 8. Combine: reserved prospective + reserved upcoming + reranked main pool
  const deterministic = [...reservedNodes, ...reservedUpcoming, ...reranked].slice(
    0,
    maxNodes - serendipitySlots,
  );
  const serendipityPicks = sampleSerendipity(scored, serendipitySlots);

  // Deduplicate serendipity against deterministic
  const deterministicIds = new Set(deterministic.map((s) => s.node.id));
  const uniqueSerendipity = serendipityPicks.filter(
    (s) => !deterministicIds.has(s.node.id),
  );

  return {
    nodes: deterministic,
    serendipityNodes: uniqueSerendipity,
    triggeredNodes: allTriggered,
    latencyMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Per-turn retrieval — mid-conversation injection
// ---------------------------------------------------------------------------

export interface TurnRetrievalOpts {
  /** The assistant's last message content. */
  assistantLastMessage: string;
  /** The user's last message content. */
  userLastMessage: string;
  /** Raw content blocks from the user's last message (for image extraction). */
  userLastMessageBlocks?: ContentBlock[];
  scopeId: string;
  config: AssistantConfig;
  tracker: InContextTracker;
  signal?: AbortSignal;
}

export interface TurnRetrievalResult {
  /** New nodes to inject (not already in context). */
  nodes: ScoredNode[];
  /** Triggers that fired this turn. */
  triggeredNodes: TriggeredResult[];
  latencyMs: number;
}

/**
 * Lightweight per-turn retrieval. Budget: p90 < 1s.
 *
 * 1. Embed last exchange (assistant + user message)
 * 2. Vector search + semantic trigger evaluation
 * 3. Filter against InContextTracker
 * 4. Score and threshold
 */
export async function retrieveForTurn(
  opts: TurnRetrievalOpts,
): Promise<TurnRetrievalResult> {
  const start = Date.now();
  const now = new Date();
  const nowMs = now.getTime();

  // 1. Build query from last exchange
  const queryText = [opts.assistantLastMessage, opts.userLastMessage]
    .filter((m) => m.length > 0)
    .join("\n\n");

  // Image-to-image search: embed incoming user images as queries
  // Runs before the text-empty early return so image-only turns are handled
  const imageBlocks = (opts.userLastMessageBlocks ?? []).filter(
    (b): b is ImageContent => b.type === "image",
  );
  const allCandidateIds = new Map<string, number>(); // nodeId → best score

  if (imageBlocks.length > 0) {
    try {
      const isMultimodal = await selectedBackendSupportsMultimodal(opts.config);
      if (isMultimodal) {
        const maxImageQueries = 2;
        for (
          let i = 0;
          i < Math.min(imageBlocks.length, maxImageQueries);
          i++
        ) {
          const img = imageBlocks[i];
          const imageInput = {
            type: "image" as const,
            data: Buffer.from(img.source.data, "base64"),
            mimeType: img.source.media_type,
          };
          const imgResult = await embedWithRetry(opts.config, [imageInput], {
            signal: opts.signal,
          });
          const imgVector = imgResult.vectors[0];
          if (imgVector) {
            const imgResults = await searchGraphNodes(imgVector, 40, [
              opts.scopeId,
            ]);
            for (const r of imgResults) {
              const current = allCandidateIds.get(r.nodeId) ?? 0;
              allCandidateIds.set(r.nodeId, Math.max(current, r.score));
            }
          }
        }
      }
    } catch (err) {
      log.warn({ err }, "Image-to-image search failed (non-fatal)");
    }
  }

  if (queryText.trim().length === 0 && allCandidateIds.size === 0) {
    return { nodes: [], triggeredNodes: [], latencyMs: Date.now() - start };
  }

  // Chunk if too large (8k token ≈ 32k chars conservative estimate)
  const maxQueryChars = 32_000;
  const chunks: string[] = [];
  if (queryText.trim().length === 0) {
    // No text to embed — skip chunking (image results may still exist)
  } else if (queryText.length <= maxQueryChars) {
    chunks.push(queryText);
  } else {
    // Split at message boundary
    if (opts.assistantLastMessage.length <= maxQueryChars) {
      chunks.push(opts.assistantLastMessage);
    }
    if (opts.userLastMessage.length <= maxQueryChars) {
      chunks.push(opts.userLastMessage);
    } else {
      // Split large message at paragraph boundaries
      const paragraphs = opts.userLastMessage.split(/\n\n+/);
      let current = "";
      for (const p of paragraphs) {
        if (current.length + p.length > maxQueryChars) {
          if (current.length > 0) chunks.push(current);
          current = p;
        } else {
          current += (current ? "\n\n" : "") + p;
        }
      }
      if (current.length > 0) chunks.push(current);
    }
  }

  // 2. Embed chunks and search (parallel)
  let queryEmbeddings: number[][] = [];

  if (chunks.length > 0) {
    try {
      const embedResults = await embedWithRetry(opts.config, chunks, {
        signal: opts.signal,
      });
      queryEmbeddings = embedResults.vectors;

      const searchPromises = queryEmbeddings.map((vec) =>
        searchGraphNodes(vec, 40, [opts.scopeId]),
      );
      const searchResults = await Promise.all(searchPromises);

      for (const results of searchResults) {
        for (const r of results) {
          const current = allCandidateIds.get(r.nodeId) ?? 0;
          allCandidateIds.set(r.nodeId, Math.max(current, r.score));
        }
      }
    } catch (err) {
      log.warn({ err }, "Embedding/search failed for turn retrieval");
      if (allCandidateIds.size === 0) {
        return { nodes: [], triggeredNodes: [], latencyMs: Date.now() - start };
      }
    }
  }

  // 3. Evaluate semantic triggers
  const semanticTriggers = getActiveTriggersByType("semantic", opts.scopeId);
  const triggeredSemantic =
    queryEmbeddings.length > 0
      ? evaluateSemanticTriggers(semanticTriggers, queryEmbeddings[0])
      : [];

  // Add triggered nodes to candidates
  for (const t of triggeredSemantic) {
    if (!allCandidateIds.has(t.trigger.nodeId)) {
      allCandidateIds.set(t.trigger.nodeId, 0);
    }
  }

  const triggerBoostMap = new Map<string, number>();
  for (const t of triggeredSemantic) {
    const current = triggerBoostMap.get(t.trigger.nodeId) ?? 0;
    triggerBoostMap.set(t.trigger.nodeId, Math.max(current, t.boost));
  }

  // 4. Filter against InContextTracker
  const newCandidateIds = [...allCandidateIds.keys()].filter(
    (id) => !opts.tracker.isInContext(id),
  );

  if (newCandidateIds.length === 0) {
    return {
      nodes: [],
      triggeredNodes: triggeredSemantic,
      latencyMs: Date.now() - start,
    };
  }

  // 5. Hydrate and score
  const nodes = getNodesByIds(newCandidateIds);
  const scored: ScoredNode[] = [];

  for (const node of nodes) {
    if (node.fidelity === "gone") continue;

    const semanticSim = allCandidateIds.get(node.id) ?? 0;
    const effectiveSig = computeEffectiveSignificance(node, nowMs);
    const temporal = computeTemporalBoost(node, now);
    const triggerBoost = triggerBoostMap.get(node.id) ?? 0;

    const normalizedTemporal = (temporal + 1) / 2;
    const recency = computeRecencyBoost(node, nowMs);

    scored.push(
      scoreCandidate(
        node,
        {
          semanticSimilarity: semanticSim,
          effectiveSignificance: effectiveSig,
          emotionalIntensity: node.emotionalCharge.intensity,
          temporalBoost: normalizedTemporal,
          recencyBoost: recency,
          triggerBoost,
          activationBoost: 0, // Skip activation spreading for per-turn (latency)
        },
        PER_TURN_WEIGHTS,
      ),
    );
  }

  // Sort and apply threshold — pull a wider pool for dedup, then trim
  scored.sort((a, b) => b.score - a.score);
  const INJECTION_THRESHOLD = 0.3;
  const PRE_DEDUP_POOL = 40;
  const MAX_INJECTED = 8;
  const pool = scored
    .filter((s) => s.score >= INJECTION_THRESHOLD)
    .slice(0, PRE_DEDUP_POOL);

  // Dedup + rerank with a fast model when the pool is large enough to warrant it
  const injected =
    pool.length > MAX_INJECTED
      ? await dedupForTurn(pool, MAX_INJECTED, opts.userLastMessage)
      : pool;

  return {
    nodes: injected,
    triggeredNodes: triggeredSemantic,
    latencyMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Periodic refresh — every N turns, replenish memory context
// ---------------------------------------------------------------------------

export interface RefreshOpts {
  /** Recent turns (last 5-6) concatenated as text. */
  recentTurnsText: string;
  scopeId: string;
  config: AssistantConfig;
  tracker: InContextTracker;
  signal?: AbortSignal;
  /** Max new nodes to inject (default 10). */
  maxNodes?: number;
}

export interface RefreshResult {
  nodes: ScoredNode[];
  latencyMs: number;
}

/** Default interval between refresh cycles. */
export const REFRESH_INTERVAL_TURNS = 5;

/**
 * Periodic context refresh. Runs every N turns to catch memories that
 * the per-turn injection missed due to its high threshold.
 *
 * Uses a wider window (recent 5-6 turns) as the query to capture the
 * evolved conversational vibe. No LLM re-ranking — pure embedding +
 * scoring for speed (~200ms).
 *
 * Also runs after compaction to replenish lost memory context.
 */
export async function refreshContextMemory(
  opts: RefreshOpts,
): Promise<RefreshResult> {
  const start = Date.now();
  const now = new Date();
  const nowMs = now.getTime();
  const maxNodes = opts.maxNodes ?? 10;

  if (opts.recentTurnsText.trim().length === 0) {
    return { nodes: [], latencyMs: Date.now() - start };
  }

  // 1. Embed recent turns window
  const queryText =
    opts.recentTurnsText.length > 6000
      ? opts.recentTurnsText.slice(-6000)
      : opts.recentTurnsText;

  let queryVector: number[] | null = null;
  try {
    const result = await embedWithRetry(opts.config, [queryText], {
      signal: opts.signal,
    });
    queryVector = result.vectors[0] ?? null;
  } catch (err) {
    log.warn({ err }, "Embedding failed for context refresh");
    return { nodes: [], latencyMs: Date.now() - start };
  }

  if (!queryVector) {
    return { nodes: [], latencyMs: Date.now() - start };
  }

  // 2. Search — cast a wider net than per-turn
  let candidates: Array<{ nodeId: string; score: number }>;
  try {
    candidates = await searchGraphNodes(queryVector, maxNodes * 3, [
      opts.scopeId,
    ]);
  } catch (err) {
    log.warn({ err }, "Qdrant search failed for context refresh");
    return { nodes: [], latencyMs: Date.now() - start };
  }

  // 3. Filter to nodes NOT already in context
  const newCandidates = candidates.filter(
    (c) => !opts.tracker.isInContext(c.nodeId),
  );

  if (newCandidates.length === 0) {
    return { nodes: [], latencyMs: Date.now() - start };
  }

  // 4. Hydrate and score
  const nodes = getNodesByIds(newCandidates.map((c) => c.nodeId));
  const candidateScoreMap = new Map(
    newCandidates.map((c) => [c.nodeId, c.score]),
  );

  const scored: ScoredNode[] = [];
  for (const node of nodes) {
    if (node.fidelity === "gone") continue;

    const semanticSim = candidateScoreMap.get(node.id) ?? 0;
    const effectiveSig = computeEffectiveSignificance(node, nowMs);
    const temporal = computeTemporalBoost(node, now);
    const recency = computeRecencyBoost(node, nowMs);

    scored.push(
      scoreCandidate(
        node,
        {
          semanticSimilarity: semanticSim,
          effectiveSignificance: effectiveSig,
          emotionalIntensity: node.emotionalCharge.intensity,
          temporalBoost: (temporal + 1) / 2,
          recencyBoost: recency,
          triggerBoost: 0,
          activationBoost: 0,
        },
        PER_TURN_WEIGHTS,
      ),
    );
  }

  // 5. Return top N — lower threshold than per-turn since this is a periodic refresh
  scored.sort((a, b) => b.score - a.score);
  const REFRESH_THRESHOLD = 0.15;
  const refreshed = scored
    .filter((s) => s.score >= REFRESH_THRESHOLD)
    .slice(0, maxNodes);

  return {
    nodes: refreshed,
    latencyMs: Date.now() - start,
  };
}

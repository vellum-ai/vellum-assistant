// ---------------------------------------------------------------------------
// Memory Graph — LLM-based consolidation engine
//
// Runs daily (or on demand). Processes nodes in partitions:
// 1. Recency: nodes from last 7 days — merge duplicates, initial narrative
// 2. Significance: top N by significance — update narrative arcs
// 3. Decay: nodes at faded/gist fidelity — candidates for merging or marking gone
// 4. Random sample: cross-pollination and pattern detection
//
// Each partition is a separate LLM call. The LLM produces a MemoryDiff
// (same format as extraction) that is applied to the graph.
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../../config/types.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db-connection.js";
import { parseEpochMs } from "./extraction.js";
import {
  createTrigger,
  deduplicateParagraphs,
  deleteNode,
  getEdgesForNode,
  getTriggersForNode,
  queryNodes,
  recordNodeEdit,
  updateNode,
} from "./store.js";
import type { MemoryNode } from "./types.js";
import { isCapabilityNode } from "./types.js";

const log = getLogger("graph-consolidation");

// ---------------------------------------------------------------------------
// Consolidation prompt
// ---------------------------------------------------------------------------

function buildConsolidationPrompt(
  partitionName: string,
  nodes: Array<{
    id: string;
    type: string;
    content: string;
    significance: number;
    fidelity: string;
    reinforcementCount: number;
    created: number;
    eventDate: number | null;
    hasImage: boolean;
  }>,
  edges: Array<{ sourceId: string; targetId: string; relationship: string }>,
): string {
  const nodeList = nodes
    .map((n) => {
      const age = Math.floor((Date.now() - n.created) / (1000 * 60 * 60 * 24));
      const eventStr =
        n.eventDate != null
          ? ` eventDate=${new Date(n.eventDate).toISOString().split("T")[0]}`
          : "";
      const imageStr = n.hasImage ? " [has_image]" : "";
      return `  [${n.id}] type=${n.type} sig=${n.significance.toFixed(
        2,
      )} fidelity=${n.fidelity} reinforced=${
        n.reinforcementCount
      }x age=${age}d${eventStr}${imageStr}\n    ${n.content}`;
    })
    .join("\n\n");

  const edgeList =
    edges.length > 0
      ? edges
          .map((e) => `  ${e.sourceId} --${e.relationship}--> ${e.targetId}`)
          .join("\n")
      : "  (none)";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `You are consolidating the "${partitionName}" partition of a memory graph. These are memories stored by an AI assistant about its conversations and relationship with a user.

Today is ${today}.

## Your Tasks

1. **Merge duplicates**: If two or more nodes describe the same event or fact, merge them into one by:
   - Keeping the richer/more complete version (UPDATE it to incorporate details from duplicates)
   - DELETE the duplicates
   - Preserve the highest significance, reinforcement count, and stability from the merged nodes
   - Create a "supersedes" edge from the surviving node to each deleted node (the store handles deletion, but log the relationship)

2. **Downgrade faded memories**: For nodes at "faded" or "gist" fidelity, rewrite their content to be shorter and more abstract — like how a real memory fades. A "faded" memory should be 1-2 sentences. A "gist" memory should be one sentence capturing only the essence.

3. **Update narrative roles**: If a node is clearly a turning point, inciting incident, or thesis in a larger story arc, set its narrativeRole and partOfStory.

4. **Mark gone**: If a node is at "gist" fidelity and has very low significance (< 0.2), mark it for deletion — it's faded beyond usefulness.

5. **Resolve stale prospective nodes**: If a prospective node (type=prospective) is older than 7 days and has no "resolved-by" edge, it's likely a stale commitment. Downgrade its fidelity to "gist" and rewrite it as a past observation (e.g. "Had planned to X" instead of "Need to X"). If it's already at gist with significance < 0.2, mark it for deletion. If the node has an event_date in the past, clear it by setting event_date to null.

## Constraints

- Do NOT create new nodes — consolidation only merges, updates, and prunes
- Do NOT change a node's type
- Do NOT increase fidelity (memories only fade, never sharpen)
- Preserve first-person prose style in content rewrites
- When merging, keep the node with higher reinforcementCount as the survivor

## Current Nodes (${partitionName})

${nodeList}

## Current Edges

${edgeList}

Use the consolidate_diff tool to output your changes.`;
}

const CONSOLIDATE_TOOL_SCHEMA = {
  name: "consolidate_diff",
  description: "Output consolidation changes to the memory graph",
  input_schema: {
    type: "object" as const,
    properties: {
      updates: {
        type: "array" as const,
        description:
          "Nodes to update (content rewrites, narrative roles, fidelity downgrades)",
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            content: {
              type: "string" as const,
              description: "New content (if rewriting)",
            },
            fidelity: {
              type: "string" as const,
              enum: ["vivid", "clear", "faded", "gist", "gone"],
            },
            narrativeRole: { type: "string" as const },
            partOfStory: { type: "string" as const },
            event_date: {
              type: ["number", "null"] as const,
              description:
                "Epoch ms of the event this memory describes. Preserve from merged duplicates when the survivor lacks one. Set to null to clear a stale event date.",
            },
          },
          required: ["id"] as const,
        },
      },
      delete_ids: {
        type: "array" as const,
        description: "Node IDs to delete (merged duplicates, gone memories)",
        items: { type: "string" as const },
      },
      merge_edges: {
        type: "array" as const,
        description: "Supersedes edges for merged nodes (survivor → deleted)",
        items: {
          type: "object" as const,
          properties: {
            survivor_id: { type: "string" as const },
            deleted_id: { type: "string" as const },
          },
          required: ["survivor_id", "deleted_id"] as const,
        },
      },
    },
    required: ["updates", "delete_ids", "merge_edges"] as const,
  },
};

// ---------------------------------------------------------------------------
// Partition builders
// ---------------------------------------------------------------------------

function getRecentNodes(scopeId: string, days: number = 7): MemoryNode[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return queryNodes({
    scopeId,
    fidelityNot: ["gone"],
    createdAfter: cutoff,
    limit: 10000,
  }).filter((n) => !isCapabilityNode(n));
}

function getTopSignificanceNodes(
  scopeId: string,
  n: number = 50,
): MemoryNode[] {
  return queryNodes({
    scopeId,
    fidelityNot: ["gone"],
    minSignificance: 0.6,
  })
    .filter((n) => !isCapabilityNode(n))
    .slice(0, n);
}

function getDecayedNodes(scopeId: string): MemoryNode[] {
  const all = queryNodes({
    scopeId,
    limit: 10000,
  });
  return all.filter(
    (n) =>
      (n.fidelity === "faded" || n.fidelity === "gist") && !isCapabilityNode(n),
  );
}

function getRandomSample(scopeId: string, n: number = 30): MemoryNode[] {
  const all = queryNodes({
    scopeId,
    fidelityNot: ["gone"],
    limit: 10000,
  }).filter((n) => !isCapabilityNode(n));
  // Fisher-Yates shuffle, take first n
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n);
}

// ---------------------------------------------------------------------------
// Run consolidation on a partition
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 25;

// ---------------------------------------------------------------------------
// Duplicate detection — fast LLM call on compact listings
// ---------------------------------------------------------------------------

const DUPE_DETECT_TOOL = {
  name: "report_duplicate_groups",
  description:
    "Report groups of nodes that describe the same event, fact, or topic and should be merged",
  input_schema: {
    type: "object" as const,
    properties: {
      groups: {
        type: "array" as const,
        description:
          "Each group is a list of node IDs that are duplicates of each other",
        items: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    required: ["groups"] as const,
  },
};

/**
 * Fast LLM pass to identify duplicate groups from a compact node listing.
 * Uses a latency-optimized model since it only needs to compare one-line
 * summaries, not reason about full prose. Returns groups of MemoryNodes
 * that should be consolidated together.
 */
async function identifyDuplicateGroups(
  nodes: MemoryNode[],
  _config: AssistantConfig,
): Promise<MemoryNode[][]> {
  if (nodes.length < 2) return [];

  const provider = await getConfiguredProvider();
  if (!provider) return [];

  // Compact listing: ID + first 100 chars of content
  const listing = nodes
    .map((n) => {
      const preview =
        n.content.length > 100 ? n.content.slice(0, 100) + "…" : n.content;
      return `[${n.id}] ${preview}`;
    })
    .join("\n");

  const systemPrompt = `You are scanning a list of memory nodes for DUPLICATES — nodes that describe the same event, fact, or topic. Group duplicates together. Two nodes are duplicates if they describe the same underlying thing, even if worded differently. Be aggressive — if in doubt, group them. Only include nodes that have at least one duplicate.`;

  const response = await provider.sendMessage(
    [userMessage(listing)],
    [DUPE_DETECT_TOOL],
    systemPrompt,
    {
      config: {
        modelIntent: "quality-optimized" as const,
        tool_choice: { type: "tool" as const, name: "report_duplicate_groups" },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock) return [];

  const input = toolBlock.input as { groups?: string[][] };
  if (!input.groups) return [];

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return (input.groups ?? [])
    .map((ids) =>
      ids.filter((id) => nodeMap.has(id)).map((id) => nodeMap.get(id)!),
    )
    .filter((group) => group.length >= 2);
}

// ---------------------------------------------------------------------------
// Consolidation partition processing
// ---------------------------------------------------------------------------

interface ConsolidationPartitionResult {
  nodesUpdated: number;
  nodesDeleted: number;
  mergeEdgesCreated: number;
}

async function consolidatePartition(
  partitionName: string,
  nodes: MemoryNode[],
  config: AssistantConfig,
): Promise<ConsolidationPartitionResult> {
  const result: ConsolidationPartitionResult = {
    nodesUpdated: 0,
    nodesDeleted: 0,
    mergeEdgesCreated: 0,
  };

  if (nodes.length === 0) return result;

  // Step 1: Fast LLM call to identify duplicate groups from compact listing
  const dupeGroups = await identifyDuplicateGroups(nodes, config);
  // Collect all nodes that appear in a duplicate group
  const inGroup = new Set(dupeGroups.flat().map((n) => n.id));
  // Singletons: nodes not in any duplicate group
  const singletons = nodes.filter((n) => !inGroup.has(n.id));

  log.info(
    {
      partition: partitionName,
      nodeCount: nodes.length,
      dupeGroups: dupeGroups.length,
      singletons: singletons.length,
    },
    "Identified duplicate groups for consolidation",
  );

  // Step 2: Run full consolidation on each duplicate group
  const deleted = new Set<string>();
  for (let i = 0; i < dupeGroups.length; i++) {
    const chunk = dupeGroups[i].filter((n) => !deleted.has(n.id));
    if (chunk.length < 2) continue;

    const chunkResult = await consolidateChunk(
      `${partitionName} dupes (${i + 1}/${dupeGroups.length})`,
      chunk,
      config,
    );
    result.nodesUpdated += chunkResult.nodesUpdated;
    result.nodesDeleted += chunkResult.nodesDeleted;
    result.mergeEdgesCreated += chunkResult.mergeEdgesCreated;
    for (const id of chunkResult.deletedIds) deleted.add(id);
  }

  // Step 3: Run consolidation on singletons in chunks (for fidelity/narrative updates)
  const remainingSingletons = singletons.filter((n) => !deleted.has(n.id));
  if (remainingSingletons.length >= 2) {
    for (let i = 0; i < remainingSingletons.length; i += CHUNK_SIZE) {
      const chunk = remainingSingletons.slice(i, i + CHUNK_SIZE);
      if (chunk.length < 2) continue;

      const chunkResult = await consolidateChunk(
        `${partitionName} singles (${Math.floor(i / CHUNK_SIZE) + 1})`,
        chunk,
        config,
      );
      result.nodesUpdated += chunkResult.nodesUpdated;
      result.nodesDeleted += chunkResult.nodesDeleted;
      result.mergeEdgesCreated += chunkResult.mergeEdgesCreated;
      for (const id of chunkResult.deletedIds) deleted.add(id);
    }
  }

  return result;
}

interface ChunkResult extends ConsolidationPartitionResult {
  deletedIds: string[];
}

async function consolidateChunk(
  chunkName: string,
  nodes: MemoryNode[],
  _config: AssistantConfig,
): Promise<ChunkResult> {
  const result: ChunkResult = {
    nodesUpdated: 0,
    nodesDeleted: 0,
    mergeEdgesCreated: 0,
    deletedIds: [],
  };

  if (nodes.length === 0) return result;

  // Collect edges between partition nodes
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: Array<{
    sourceId: string;
    targetId: string;
    relationship: string;
  }> = [];
  for (const node of nodes) {
    for (const edge of getEdgesForNode(node.id)) {
      if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
        edges.push({
          sourceId: edge.sourceNodeId,
          targetId: edge.targetNodeId,
          relationship: edge.relationship,
        });
      }
    }
  }

  // Deduplicate edges
  const edgeKeys = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    const key = `${e.sourceId}-${e.relationship}-${e.targetId}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    return true;
  });

  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new BackendUnavailableError("Provider unavailable for consolidation");
  }

  const systemPrompt = buildConsolidationPrompt(
    chunkName,
    nodes.map((n) => ({
      id: n.id,
      type: n.type,
      content: n.content,
      significance: n.significance,
      fidelity: n.fidelity,
      reinforcementCount: n.reinforcementCount,
      created: n.created,
      eventDate: n.eventDate,
      hasImage: n.imageRefs != null && n.imageRefs.length > 0,
    })),
    dedupedEdges,
  );

  const response = await provider.sendMessage(
    [
      userMessage(
        "Consolidate this partition. Focus on merging duplicates and fading old memories.",
      ),
    ],
    [CONSOLIDATE_TOOL_SCHEMA],
    systemPrompt,
    {
      config: {
        modelIntent: "quality-optimized" as const,
        tool_choice: { type: "tool" as const, name: "consolidate_diff" },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock) {
    log.warn("No tool_use block in consolidation response");
    return result;
  }

  const input = toolBlock.input as {
    updates?: Array<{
      id: string;
      content?: string;
      fidelity?: string;
      narrativeRole?: string;
      partOfStory?: string;
      event_date?: number | null;
    }>;
    delete_ids?: string[];
    merge_edges?: Array<{ survivor_id: string; deleted_id: string }>;
  };

  // Build nodeMap once upfront; patch entries after each updateNode() so
  // later iterations always read fresh in-memory state.
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Apply updates
  for (const update of input.updates ?? []) {
    if (!nodeIds.has(update.id)) continue; // safety: only update nodes in this partition

    const changes: Partial<MemoryNode> = {};
    if (update.content) changes.content = update.content;
    if (update.fidelity)
      changes.fidelity = update.fidelity as MemoryNode["fidelity"];
    if (update.narrativeRole !== undefined)
      changes.narrativeRole = update.narrativeRole || null;
    if (update.partOfStory !== undefined)
      changes.partOfStory = update.partOfStory || null;
    if (update.event_date !== undefined)
      changes.eventDate = parseEpochMs(update.event_date);
    changes.lastConsolidated = Date.now();

    if (Object.keys(changes).length > 1) {
      // more than just lastConsolidated

      // Wrap edit recording + node update in a transaction so they are atomic:
      // if updateNode fails, the edit record is rolled back.
      getDb().transaction(() => {
        if (changes.content) {
          const cleanContent = deduplicateParagraphs(changes.content);
          const node = nodeMap.get(update.id);
          if (node && node.content !== cleanContent) {
            recordNodeEdit({
              nodeId: update.id,
              previousContent: node.content,
              newContent: cleanContent,
              source: "consolidation",
            });
          }
        }

        updateNode(update.id, changes);
      });
      result.nodesUpdated++;
      // Sync in-memory state with what updateNode actually wrote to the DB
      // (updateNode deduplicates content before persisting)
      if (changes.content)
        changes.content = deduplicateParagraphs(changes.content);
      const node = nodeMap.get(update.id);
      if (node) Object.assign(node, changes);
    }
  }

  // Apply merge edges (before deletion so the edge can reference the node)
  const { createEdge } = await import("./store.js");
  for (const merge of input.merge_edges ?? []) {
    if (!nodeIds.has(merge.survivor_id) || !nodeIds.has(merge.deleted_id))
      continue;
    try {
      createEdge({
        sourceNodeId: merge.survivor_id,
        targetNodeId: merge.deleted_id,
        relationship: "supersedes",
        weight: 1.0,
        created: Date.now(),
      });
      result.mergeEdgesCreated++;

      // Preserve eventDate from deleted node if survivor doesn't have one
      const survivor = nodeMap.get(merge.survivor_id);
      const deleted = nodeMap.get(merge.deleted_id);
      if (
        survivor &&
        deleted?.eventDate != null &&
        survivor.eventDate == null
      ) {
        updateNode(merge.survivor_id, { eventDate: deleted.eventDate });
        survivor.eventDate = deleted.eventDate;

        // The deleted node's triggers will be cascade-deleted when the node
        // is removed. Ensure the survivor has an event trigger for the
        // inherited eventDate (updateNode only syncs existing triggers).
        const survivorTriggers = getTriggersForNode(merge.survivor_id);
        if (!survivorTriggers.some((t) => t.type === "event")) {
          createTrigger({
            nodeId: merge.survivor_id,
            type: "event",
            schedule: null,
            condition: null,
            conditionEmbedding: null,
            threshold: null,
            eventDate: deleted.eventDate,
            rampDays: 7,
            followUpDays: 2,
            recurring: false,
            consumed: false,
            cooldownMs: null,
            lastFired: null,
          });
        }
      }

      // Preserve imageRefs from deleted node if survivor doesn't have any
      if (
        survivor &&
        deleted?.imageRefs != null &&
        deleted.imageRefs.length > 0 &&
        (survivor.imageRefs == null || survivor.imageRefs.length === 0)
      ) {
        updateNode(merge.survivor_id, { imageRefs: deleted.imageRefs });
        survivor.imageRefs = deleted.imageRefs;
      }
    } catch (err) {
      log.warn({ err }, "Failed to create merge edge");
    }
  }

  // Apply deletions
  for (const id of input.delete_ids ?? []) {
    if (!nodeIds.has(id)) continue; // safety
    try {
      log.info({ nodeId: id }, "Consolidation deleting node");
      deleteNode(id);
      result.nodesDeleted++;
      result.deletedIds.push(id);
    } catch (err) {
      log.warn({ id, err }, "Failed to delete node during consolidation");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Full consolidation run
// ---------------------------------------------------------------------------

export interface ConsolidationResult {
  partitions: Record<string, ConsolidationPartitionResult>;
  totalUpdated: number;
  totalDeleted: number;
  totalMergeEdges: number;
  latencyMs: number;
}

export async function runConsolidation(
  scopeId: string = "default",
  config: AssistantConfig,
): Promise<ConsolidationResult> {
  const start = Date.now();

  const result: ConsolidationResult = {
    partitions: {},
    totalUpdated: 0,
    totalDeleted: 0,
    totalMergeEdges: 0,
    latencyMs: 0,
  };

  // Define partitions
  const partitions: Array<{ name: string; nodes: MemoryNode[] }> = [
    { name: "recent", nodes: getRecentNodes(scopeId) },
    { name: "significant", nodes: getTopSignificanceNodes(scopeId) },
    { name: "decayed", nodes: getDecayedNodes(scopeId) },
    { name: "random", nodes: getRandomSample(scopeId) },
  ];

  for (const partition of partitions) {
    if (partition.nodes.length === 0) {
      log.info({ partition: partition.name }, "Empty partition, skipping");
      continue;
    }

    log.info(
      { partition: partition.name, nodeCount: partition.nodes.length },
      "Consolidating partition",
    );

    try {
      const partitionResult = await consolidatePartition(
        partition.name,
        partition.nodes,
        config,
      );

      result.partitions[partition.name] = partitionResult;
      result.totalUpdated += partitionResult.nodesUpdated;
      result.totalDeleted += partitionResult.nodesDeleted;
      result.totalMergeEdges += partitionResult.mergeEdgesCreated;

      log.info(
        {
          partition: partition.name,
          updated: partitionResult.nodesUpdated,
          deleted: partitionResult.nodesDeleted,
          mergeEdges: partitionResult.mergeEdgesCreated,
        },
        "Partition consolidation complete",
      );
    } catch (err) {
      log.warn(
        {
          partition: partition.name,
          err: err instanceof Error ? err.message : String(err),
        },
        "Partition consolidation failed",
      );
      result.partitions[partition.name] = {
        nodesUpdated: 0,
        nodesDeleted: 0,
        mergeEdgesCreated: 0,
      };
    }
  }

  result.latencyMs = Date.now() - start;

  log.info(
    {
      totalUpdated: result.totalUpdated,
      totalDeleted: result.totalDeleted,
      totalMergeEdges: result.totalMergeEdges,
      latencyMs: result.latencyMs,
    },
    "Full consolidation complete",
  );

  return result;
}

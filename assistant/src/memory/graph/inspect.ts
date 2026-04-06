// ---------------------------------------------------------------------------
// Memory Graph — CLI inspection tool for testing
//
// Usage (from assistant/):
//   bun run src/memory/graph/inspect.ts --stats
//   bun run src/memory/graph/inspect.ts --context-load
//   bun run src/memory/graph/inspect.ts --query "what does the user think about X"
//   bun run src/memory/graph/inspect.ts --node <id>
//   bun run src/memory/graph/inspect.ts --turn "user said this"
//   bun run src/memory/graph/inspect.ts --bootstrap [--limit N] [--dry-run]
//   bun run src/memory/graph/inspect.ts --bootstrap-journal
//   bun run src/memory/graph/inspect.ts --decay
// ---------------------------------------------------------------------------

import { getConfig } from "../../config/loader.js";
import { initializeDb } from "../db-init.js";
import { initQdrantClient } from "../qdrant-client.js";
import {
  countNodes,
  getEdgesForNode,
  getNode,
  getTriggersForNode,
  queryNodes,
} from "./store.js";
import type { ScoredNode } from "./types.js";

// Initialize DB and Qdrant before anything else
initializeDb();
const config = getConfig();
try {
  initQdrantClient({
    url: config.memory.qdrant.url ?? "http://127.0.0.1:6333",
    collection: config.memory.qdrant.collection,
    vectorSize: config.memory.qdrant.vectorSize,
    onDisk: config.memory.qdrant.onDisk ?? true,
    quantization: config.memory.qdrant.quantization ?? "none",
  });
} catch {
  // Qdrant may already be initialized
}

const args = process.argv.slice(2);

async function main() {
  if (args.includes("--stats")) {
    await showStats();
  } else if (args.includes("--list")) {
    showList();
  } else if (args.includes("--context-load")) {
    await showContextLoad();
  } else if (args.includes("--query")) {
    const idx = args.indexOf("--query");
    const query = args[idx + 1];
    if (!query) {
      console.error("Usage: --query <search text>");
      process.exit(1);
    }
    await showQuery(query);
  } else if (args.includes("--node")) {
    const idx = args.indexOf("--node");
    const nodeId = args[idx + 1];
    if (!nodeId) {
      console.error("Usage: --node <node-id>");
      process.exit(1);
    }
    showNode(nodeId);
  } else if (args.includes("--turn")) {
    const idx = args.indexOf("--turn");
    const userMsg = args[idx + 1];
    if (!userMsg) {
      console.error('Usage: --turn "user message"');
      process.exit(1);
    }
    await showTurn(userMsg);
  } else if (args.includes("--bootstrap")) {
    await runBootstrap();
  } else if (args.includes("--bootstrap-journal")) {
    await runJournalBootstrap();
  } else if (args.includes("--consolidate")) {
    await runConsolidate();
  } else if (args.includes("--pattern-scan")) {
    await runPatterns();
  } else if (args.includes("--narrative")) {
    await runNarrative();
  } else if (args.includes("--decay")) {
    runDecay();
  } else {
    console.log(`Memory Graph Inspector

Commands:
  --stats                Show graph statistics
  --list [--type X]      List all nodes (optionally filter by type)
  --context-load         Simulate conversation start retrieval
  --query "text"         Search graph nodes by content
  --node <id>            Show a specific node and its connections
  --turn "user msg"      Simulate mid-conversation injection
  --consolidate          Run consolidation (merge dupes, fade old)
  --pattern-scan         Detect recurring patterns
  --narrative            Refine narrative arcs
  --bootstrap [--limit N] [--dry-run]  Re-extract from history
  --bootstrap-journal    Extract from journal files
  --decay                Run a decay tick
`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function showList() {
  const scopeId = "default";
  const typeIdx = args.indexOf("--type");
  const typeFilter = typeIdx >= 0 ? args[typeIdx + 1] : undefined;

  const allNodes = queryNodes({
    scopeId,
    fidelityNot: ["gone"],
    limit: 100000,
  });
  const filtered = typeFilter
    ? allNodes.filter((n) => n.type === typeFilter)
    : allNodes;

  // Sort by created desc (newest first)
  filtered.sort((a, b) => b.created - a.created);

  console.log(
    `\n  Nodes${typeFilter ? ` (type: ${typeFilter})` : ""}: ${filtered.length}\n`,
  );
  for (const node of filtered) {
    const age = relativeAge(node.created);
    const preview =
      node.content.length > 90 ? node.content.slice(0, 90) + "…" : node.content;
    console.log(
      `  ${node.id}  [${node.type}] (${age}, sig=${node.significance.toFixed(2)}) ${preview}`,
    );
  }
  console.log();
}

function relativeAge(epochMs: number): string {
  const elapsed = Date.now() - epochMs;
  const mins = Math.floor(elapsed / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 90) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

async function showStats() {
  const scopeId = "default";
  const total = countNodes(scopeId);
  const allNodes = queryNodes({
    scopeId,
    fidelityNot: ["gone"],
    limit: 100000,
  });

  const byType = new Map<string, number>();
  const byFidelity = new Map<string, number>();
  let totalEdges = 0;
  let totalTriggers = 0;

  for (const node of allNodes) {
    byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    byFidelity.set(node.fidelity, (byFidelity.get(node.fidelity) ?? 0) + 1);
    totalEdges += getEdgesForNode(node.id).length;
    totalTriggers += getTriggersForNode(node.id).length;
  }

  // Edges are counted twice (once per endpoint), so halve
  totalEdges = Math.floor(totalEdges / 2);

  console.log(`\n  Memory Graph Stats (scope: ${scopeId})`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  Total nodes: ${total}`);
  console.log(`  Total edges: ${totalEdges}`);
  console.log(`  Total triggers: ${totalTriggers}`);
  console.log(`\n  By type:`);
  for (const [type, count] of [...byType.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${type}: ${count}`);
  }
  console.log(`\n  By fidelity:`);
  for (const [fidelity, count] of [...byFidelity.entries()].sort()) {
    console.log(`    ${fidelity}: ${count}`);
  }

  // Sample content
  if (allNodes.length > 0) {
    console.log(`\n  Sample nodes (top 5 by significance):`);
    const top = [...allNodes]
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 5);
    for (const node of top) {
      const preview =
        node.content.length > 100
          ? node.content.slice(0, 100) + "…"
          : node.content;
      console.log(
        `    ${node.id}  [${node.type}] (sig=${node.significance.toFixed(2)}) ${preview}`,
      );
    }
  }
  console.log();
}

async function showContextLoad() {
  const { loadContextMemory } = await import("./retriever.js");

  console.log("\n  Simulating context load (conversation start)...\n");

  const result = await loadContextMemory({
    scopeId: "default",
    recentSummaries: [], // No recent summaries for standalone test
    config,
  });

  console.log(
    `  Retrieved ${result.nodes.length} nodes in ${result.latencyMs}ms`,
  );
  console.log(`  Triggered: ${result.triggeredNodes.length} triggers fired`);

  // Show assembled context
  const { assembleContextBlock } = await import("./injection.js");
  const block = assembleContextBlock(result.nodes, {
    serendipityNodes: result.serendipityNodes,
  });

  if (block) {
    console.log(`\n  --- Assembled Context Block ---\n`);
    console.log(block);
    console.log(`\n  --- End Context Block ---\n`);
  } else {
    console.log("  (no context to inject)");
  }

  printScoredNodes(result.nodes);
}

async function showQuery(query: string) {
  const { embedWithRetry } = await import("../embed.js");
  const { searchGraphNodes } = await import("./graph-search.js");
  const { getNodesByIds } = await import("./store.js");

  console.log(`\n  Searching: "${query}"\n`);

  try {
    const embedding = await embedWithRetry(config, [query]);
    const vector = embedding.vectors[0];
    if (!vector) {
      console.error("  Failed to embed query");
      return;
    }

    const results = await searchGraphNodes(vector, 20, ["default"]);
    if (results.length === 0) {
      console.log("  No results found.");
      return;
    }

    const nodes = getNodesByIds(results.map((r) => r.nodeId));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const visible = results.filter((r) => {
      const node = nodeMap.get(r.nodeId);
      return node && node.fidelity !== "gone";
    });

    if (visible.length === 0) {
      console.log("  No results found.");
      return;
    }

    console.log(`  Found ${visible.length} results:\n`);
    for (const r of visible) {
      const node = nodeMap.get(r.nodeId)!;
      const preview =
        node.content.length > 120
          ? node.content.slice(0, 120) + "…"
          : node.content;
      console.log(
        `  ${r.nodeId}  [${r.score.toFixed(3)}] (${node.type}, sig=${node.significance.toFixed(2)}) ${preview}`,
      );
    }
  } catch (err) {
    console.error(
      `  Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log();
}

function showNode(nodeId: string) {
  const node = getNode(nodeId);
  if (!node) {
    console.error(`  Node not found: ${nodeId}`);
    return;
  }

  console.log(`\n  Node: ${node.id}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Type: ${node.type}`);
  console.log(`  Fidelity: ${node.fidelity}`);
  console.log(`  Confidence: ${node.confidence.toFixed(2)}`);
  console.log(`  Significance: ${node.significance.toFixed(2)}`);
  console.log(`  Stability: ${node.stability.toFixed(1)}`);
  console.log(`  Reinforcements: ${node.reinforcementCount}`);
  console.log(`  Source: ${node.sourceType}`);
  console.log(`  Created: ${new Date(node.created).toISOString()}`);
  console.log(
    `  Event date: ${node.eventDate != null ? new Date(node.eventDate).toISOString() : "none"}`,
  );
  console.log(
    `  Emotional: valence=${node.emotionalCharge.valence.toFixed(2)} intensity=${node.emotionalCharge.intensity.toFixed(2)} curve=${node.emotionalCharge.decayCurve}`,
  );
  if (node.narrativeRole)
    console.log(`  Narrative role: ${node.narrativeRole}`);
  if (node.partOfStory) console.log(`  Part of story: ${node.partOfStory}`);
  console.log(`  Source conversations: ${node.sourceConversations.length}`);
  console.log(`\n  Content:\n  ${node.content}\n`);

  // Edges
  const edges = getEdgesForNode(node.id);
  if (edges.length > 0) {
    console.log(`  Edges (${edges.length}):`);
    for (const edge of edges) {
      const otherId =
        edge.sourceNodeId === node.id ? edge.targetNodeId : edge.sourceNodeId;
      const direction = edge.sourceNodeId === node.id ? "→" : "←";
      const other = getNode(otherId);
      const preview = other
        ? other.content.length > 60
          ? other.content.slice(0, 60) + "…"
          : other.content
        : "(deleted)";
      console.log(
        `    ${direction} [${edge.relationship}] (w=${edge.weight.toFixed(2)}) ${preview}`,
      );
    }
  }

  // Triggers
  const triggers = getTriggersForNode(node.id);
  if (triggers.length > 0) {
    console.log(`\n  Triggers (${triggers.length}):`);
    for (const t of triggers) {
      const detail =
        t.type === "temporal"
          ? t.schedule
          : t.type === "semantic"
            ? t.condition
            : t.eventDate
              ? new Date(t.eventDate).toISOString()
              : "?";
      console.log(
        `    [${t.type}] ${detail} ${t.recurring ? "(recurring)" : ""} ${t.consumed ? "(consumed)" : ""}`,
      );
    }
  }
  console.log();
}

async function showTurn(userMessage: string) {
  const { retrieveForTurn } = await import("./retriever.js");
  const { InContextTracker } = await import("./injection.js");
  const { assembleInjectionBlock } = await import("./injection.js");

  const tracker = new InContextTracker();

  console.log(`\n  Simulating per-turn retrieval for: "${userMessage}"\n`);

  const result = await retrieveForTurn({
    assistantLastMessage: "",
    userLastMessage: userMessage,
    scopeId: "default",
    config,
    tracker,
  });

  console.log(
    `  Found ${result.nodes.length} new nodes in ${result.latencyMs}ms`,
  );
  console.log(`  Triggered: ${result.triggeredNodes.length} semantic triggers`);

  if (result.nodes.length > 0) {
    const block = assembleInjectionBlock(result.nodes);
    console.log(`\n  Injection: ${block}\n`);
    printScoredNodes(result.nodes);
  } else {
    console.log("  (nothing to inject)\n");
  }
}

async function runBootstrap() {
  const { bootstrapFromHistory, resetBootstrapCheckpoint } =
    await import("./bootstrap.js");

  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : undefined;
  const dryRun = args.includes("--dry-run");

  if (args.includes("--reset")) {
    resetBootstrapCheckpoint();
    console.log("  Bootstrap checkpoint reset.\n");
  }

  console.log(
    `\n  Starting bootstrap${dryRun ? " (dry run)" : ""}${limit ? ` (limit: ${limit})` : ""}...\n`,
  );

  const result = await bootstrapFromHistory({ limit, dryRun });

  console.log(`  Bootstrap complete:`);
  console.log(`    Conversations processed: ${result.conversationsProcessed}`);
  console.log(`    Conversations skipped: ${result.conversationsSkipped}`);
  console.log(`    Nodes created: ${result.totalNodesCreated}`);
  console.log(`    Nodes updated: ${result.totalNodesUpdated}`);
  console.log(`    Nodes reinforced: ${result.totalNodesReinforced}`);
  console.log(`    Edges created: ${result.totalEdgesCreated}`);
  console.log(`    Triggers created: ${result.totalTriggersCreated}`);
  console.log(`    Errors: ${result.errors.length}`);
  console.log(`    Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`);

  if (result.errors.length > 0) {
    console.log(`\n  Errors:`);
    for (const e of result.errors.slice(0, 10)) {
      console.log(`    ${e.conversationId}: ${e.error}`);
    }
    if (result.errors.length > 10) {
      console.log(`    ... and ${result.errors.length - 10} more`);
    }
  }
  console.log();
}

async function runJournalBootstrap() {
  const { bootstrapFromJournal } = await import("./bootstrap.js");

  console.log("\n  Extracting from journal files...\n");
  const result = await bootstrapFromJournal();
  console.log(`  Journal entries extracted: ${result.extracted}`);
  console.log(`  Errors: ${result.errors}`);
  console.log();
}

async function runConsolidate() {
  const { runConsolidation } = await import("./consolidation.js");
  console.log("\n  Running consolidation...\n");
  const result = await runConsolidation("default", config);
  console.log(
    `  Consolidation complete (${(result.latencyMs / 1000).toFixed(1)}s):`,
  );
  console.log(`    Nodes updated: ${result.totalUpdated}`);
  console.log(`    Nodes deleted (merged): ${result.totalDeleted}`);
  console.log(`    Merge edges created: ${result.totalMergeEdges}`);
  console.log(`\n  By partition:`);
  for (const [name, p] of Object.entries(result.partitions)) {
    console.log(
      `    ${name}: ${p.nodesUpdated} updated, ${p.nodesDeleted} deleted, ${p.mergeEdgesCreated} merged`,
    );
  }
  console.log();
}

async function runPatterns() {
  const { runPatternScan } = await import("./pattern-scan.js");
  console.log("\n  Running pattern scan...\n");
  const result = await runPatternScan("default", config);
  console.log(
    `  Pattern scan complete (${(result.latencyMs / 1000).toFixed(1)}s):`,
  );
  console.log(`    Patterns detected: ${result.patternsDetected}`);
  console.log(`    Edges created: ${result.edgesCreated}`);
  console.log();
}

async function runNarrative() {
  const { runNarrativeRefinement } = await import("./narrative.js");
  console.log("\n  Running narrative refinement...\n");
  const result = await runNarrativeRefinement("default", config);
  console.log(
    `  Narrative refinement complete (${(result.latencyMs / 1000).toFixed(1)}s):`,
  );
  console.log(`    Nodes updated: ${result.nodesUpdated}`);
  console.log(`    Arcs identified: ${result.arcsIdentified}`);
  if (result.arcs.length > 0) {
    console.log(`\n  Story arcs:`);
    for (const arc of result.arcs) {
      console.log(
        `    "${arc.name}" (${arc.nodeCount} nodes): ${arc.description}`,
      );
    }
  }
  console.log();
}

function runDecay() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runDecayTick } = require("./decay.js") as typeof import("./decay.js");
  console.log("\n  Running decay tick...\n");
  const result = runDecayTick("default");
  console.log(`  Nodes processed: ${result.nodesProcessed}`);
  console.log(`  Emotional decays: ${result.emotionalDecays}`);
  console.log(`  Fidelity downgrades: ${result.fidelityDowngrades}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printScoredNodes(nodes: ScoredNode[]) {
  if (nodes.length === 0) return;
  console.log(`  Scored nodes:`);
  for (const s of nodes) {
    const b = s.scoreBreakdown;
    const preview =
      s.node.content.length > 80
        ? s.node.content.slice(0, 80) + "…"
        : s.node.content;
    console.log(
      `    ${s.node.id}  [${s.score.toFixed(3)}] sem=${b.semanticSimilarity.toFixed(2)} sig=${b.effectiveSignificance.toFixed(2)} emo=${b.emotionalIntensity.toFixed(2)} tmp=${b.temporalBoost.toFixed(2)} rec=${b.recencyBoost.toFixed(2)} trg=${b.triggerBoost.toFixed(2)} act=${b.activationBoost.toFixed(2)}`,
    );
    console.log(`           (${s.node.type}) ${preview}`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });

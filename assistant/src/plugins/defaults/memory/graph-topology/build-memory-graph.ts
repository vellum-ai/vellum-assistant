/**
 * Produce the canonical {@link MemoryGraph} from the active memory backend.
 *
 * Today the active backend is memory-v3, whose knowledge corpus is already an
 * Obsidian-style graph: markdown articles (identified by slug) linked by
 * authored `links:` frontmatter / inline `[[wikilinks]]` (the STATIC link
 * graph) plus behavioral co-selection associations (the LEARNED edge graph).
 * This module reads exactly the same sources the v3 retrieval lanes build from
 * (`getPageIndex` + `buildEdgeGraph` + `computeLearnedEdgeGraph`) and maps them
 * into the backend-agnostic contract — no embeddings, no LLM calls.
 *
 * The mapping is split into a pure {@link assembleMemoryGraph} (unit-testable
 * with plain inputs) and a thin {@link getMemoryGraph} that does the workspace
 * / DB I/O. When the memory-backend plugin seam lands, `getMemoryGraph` becomes
 * a call into `backend.getGraph()` — the contract and its route do not change.
 */

import { isMemoryV3Live } from "../../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../../config/types.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { getPageIndex, type PageIndexEntry } from "../v2/page-index.js";
import { readPage, renderPageContent } from "../v2/page-store.js";
import { buildEdgeGraph } from "../v3/edge.js";
import { computeLearnedEdgeGraph } from "../v3/learned-edges.js";
import type { Slug } from "../v3/types.js";
import type {
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphNodeDetail,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches the selection window the v3 shadow lanes read for learned edges. */
const LEARNED_EDGES_WINDOW_DAYS = 90;
/** Backend identifier stamped onto graphs produced from memory-v3. */
const BACKEND_MEMORY_V3 = "memory-v3";
/**
 * Upper bound on returned nodes. Real corpora sit well under this (~100–500);
 * the cap is a payload/render backstop. When exceeded, the highest-degree nodes
 * are kept and `truncated` is set.
 */
const DEFAULT_MAX_NODES = 750;

/** Adjacency as produced by `buildEdgeGraph` / `computeLearnedEdgeGraph`:
 * source → (target → curated description | undefined). */
type Adjacency = Map<Slug, Map<Slug, string | undefined>>;

/** Order-independent key for an undirected pair, so (a,b) and (b,a) collapse. */
function undirectedKey(a: string, b: string): string {
  return a < b ? `${a}\t${b}` : `${b}\t${a}`;
}

/** Title-ish label from a slug: last path segment, separators → spaces,
 * word-initial caps. `skills/agent-mail` → `Agent Mail`. */
function humanizeSlug(slug: string): string {
  const last = slug.split("/").pop() ?? slug;
  const words = last.replace(/[-_]+/g, " ").trim();
  if (!words) return slug;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Node taxonomy tag used for coloring. Synthetic capability slugs (skills /
 * CLI commands) carry `modifiedAt: 0`; real concept pages carry a file mtime. */
function nodeKind(entry: PageIndexEntry): string {
  if (entry.slug.startsWith("skills/")) return "skill";
  if (entry.modifiedAt <= 0) return "capability";
  return "concept";
}

/** A real concept page: on-disk (has an mtime) and not a synthetic skill or
 * CLI-command capability slug. The graph shows concepts only. */
function isConceptEntry(entry: PageIndexEntry): boolean {
  return entry.modifiedAt > 0 && !entry.slug.startsWith("skills/");
}

export interface AssembleMemoryGraphInput {
  /** Every article node in the corpus (page-index entries). */
  entries: readonly PageIndexEntry[];
  /** Directed static link graph (authored `links:` + wikilinks + numeric). */
  staticAdjacency: Adjacency;
  /** Undirected learned co-selection graph, or undefined when disabled. */
  learnedAdjacency?: Adjacency;
  /** Node cap; defaults to {@link DEFAULT_MAX_NODES}. */
  maxNodes?: number;
}

/**
 * Pure mapping from v3's article + edge structures to the canonical graph.
 *
 * Static edges are emitted directed (kind `link`), carrying their curated
 * description when present. Learned edges are emitted undirected (kind
 * `learned`), deduped against each other AND against any static edge on the
 * same pair (an authored link supersedes the learned association visually).
 * Edges referencing a slug with no node entry are dropped. Node `weight` is the
 * resulting degree, and drives the truncation ranking.
 */
export function assembleMemoryGraph(
  input: AssembleMemoryGraphInput,
): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; truncated?: boolean } {
  const { entries, staticAdjacency, learnedAdjacency } = input;
  const maxNodes = input.maxNodes ?? DEFAULT_MAX_NODES;

  const nodeIds = new Set<string>(entries.map((e) => e.slug));
  const degree = new Map<string, number>();
  const bump = (id: string): void => {
    degree.set(id, (degree.get(id) ?? 0) + 1);
  };

  const edges: MemoryGraphEdge[] = [];
  const staticPairs = new Set<string>();

  // Static link edges — directed, authored/structural.
  for (const [source, out] of staticAdjacency) {
    if (!nodeIds.has(source)) continue;
    for (const [target, description] of out) {
      if (!nodeIds.has(target)) continue;
      const edge: MemoryGraphEdge = {
        source,
        target,
        kind: "link",
        directed: true,
      };
      if (description) edge.description = description;
      edges.push(edge);
      staticPairs.add(undirectedKey(source, target));
      bump(source);
      bump(target);
    }
  }

  // Learned edges — undirected, deduped against static and each other.
  if (learnedAdjacency) {
    const emitted = new Set<string>();
    for (const [source, out] of learnedAdjacency) {
      if (!nodeIds.has(source)) continue;
      for (const target of out.keys()) {
        if (!nodeIds.has(target)) continue;
        const key = undirectedKey(source, target);
        if (staticPairs.has(key) || emitted.has(key)) continue;
        emitted.add(key);
        const [a, b] = key.split("\t") as [string, string];
        edges.push({ source: a, target: b, kind: "learned", directed: false });
        bump(a);
        bump(b);
      }
    }
  }

  let nodes: MemoryGraphNode[] = entries.map((entry) => {
    const node: MemoryGraphNode = {
      id: entry.slug,
      label: humanizeSlug(entry.slug),
      kind: nodeKind(entry),
      weight: degree.get(entry.slug) ?? 0,
    };
    if (entry.summary) node.summary = entry.summary;
    if (entry.modifiedAt > 0) node.updatedAtMs = entry.modifiedAt;
    return node;
  });

  if (nodes.length <= maxNodes) {
    return { nodes, edges };
  }

  // Over the cap — keep the highest-degree nodes and drop dangling edges.
  nodes = [...nodes]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, maxNodes);
  const kept = new Set(nodes.map((n) => n.id));
  const keptEdges = edges.filter(
    (e) => kept.has(e.source) && kept.has(e.target),
  );
  return { nodes, edges: keptEdges, truncated: true };
}

/**
 * Build the canonical memory graph for the active backend. Returns an
 * unsupported, empty graph when memory-v3 is not the live backend, so callers
 * can render a graceful empty state rather than an error.
 */
export async function getMemoryGraph(
  config: AssistantConfig,
): Promise<MemoryGraph> {
  if (!isMemoryV3Live(config)) {
    return { backend: null, supported: false, nodes: [], edges: [] };
  }

  const workspaceDir = getWorkspaceDir();
  const pageIndex = await getPageIndex(workspaceDir);
  // Concepts only: exclude synthetic skill / CLI-command slugs so the graph is
  // purely the assistant's learned/authored concept pages. Edges to excluded
  // slugs drop out downstream because they aren't in the node set.
  const conceptEntries = pageIndex.entries.filter(isConceptEntry);

  // Raw (frontmatter + body) page reader, matching the v3 lane build. A read
  // that rejects drops that article's authored/wikilink edges but keeps its
  // numeric fallbacks.
  const pageRaw = async (slug: Slug): Promise<string> => {
    const page = await readPage(workspaceDir, slug);
    if (!page) throw new Error(`page not found: ${slug}`);
    return renderPageContent(page);
  };

  const staticGraph = await buildEdgeGraph(conceptEntries, pageRaw, {
    hubDegree: config.memory.v3.edge.hubDegree,
  });

  // Viz-tuned learned edges: deliberately looser than the retrieval lane so the
  // graph reads as a connected web instead of scattered orphans. This endpoint
  // is visualization-only, so surfacing weaker co-selection associations (and a
  // little extra edge noise) is a fair trade. Floors keep the thresholds sane
  // even when the retrieval config is aggressive or disables the lane.
  const learned = config.memory.v3.learnedEdges;
  const learnedGraph = computeLearnedEdgeGraph(
    { db: getDb() },
    {
      halfLifeMs: learned.halfLifeDays * DAY_MS,
      minCount: Math.max(1, learned.minCount * 0.5),
      npmiFloor: Math.max(0, learned.npmiFloor * 0.4),
      maxPerPage: Math.max(learned.maxPerPage, 14),
      now: Date.now(),
      windowMs: LEARNED_EDGES_WINDOW_DAYS * DAY_MS,
      knownSlugs: new Set(conceptEntries.map((e) => e.slug)),
    },
  );

  const assembled = assembleMemoryGraph({
    entries: conceptEntries,
    staticAdjacency: staticGraph.adjacency,
    learnedAdjacency: learnedGraph.adjacency,
  });

  return { backend: BACKEND_MEMORY_V3, supported: true, ...assembled };
}

/**
 * Fetch a single concept node's content (its markdown body) by id. Used when a
 * user opens a node in the graph. Concepts only — skill/capability slugs and
 * unreadable pages return `{ found: false }`.
 */
export async function getMemoryGraphNode(
  config: AssistantConfig,
  id: string,
): Promise<MemoryGraphNodeDetail> {
  if (!isMemoryV3Live(config) || !id || id.startsWith("skills/")) {
    return { found: false };
  }
  const page = await readPage(getWorkspaceDir(), id).catch(() => null);
  if (!page) return { found: false };
  return { found: true, title: humanizeSlug(id), content: page.body };
}

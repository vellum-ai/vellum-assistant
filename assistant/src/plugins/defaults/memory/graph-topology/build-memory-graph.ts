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
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode } from "./types.js";

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

  // Raw (frontmatter + body) page reader, matching the v3 lane build. A read
  // that rejects (e.g. synthetic capability slugs with no on-disk page) drops
  // that article's authored/wikilink edges but keeps its numeric fallbacks.
  const pageRaw = async (slug: Slug): Promise<string> => {
    const page = await readPage(workspaceDir, slug);
    if (!page) throw new Error(`page not found: ${slug}`);
    return renderPageContent(page);
  };

  const staticGraph = await buildEdgeGraph(pageIndex.entries, pageRaw, {
    hubDegree: config.memory.v3.edge.hubDegree,
  });

  const learned = config.memory.v3.learnedEdges;
  const learnedGraph =
    learned.maxPerPage > 0
      ? computeLearnedEdgeGraph(
          { db: getDb() },
          {
            halfLifeMs: learned.halfLifeDays * DAY_MS,
            minCount: learned.minCount,
            npmiFloor: learned.npmiFloor,
            maxPerPage: learned.maxPerPage,
            now: Date.now(),
            windowMs: LEARNED_EDGES_WINDOW_DAYS * DAY_MS,
            knownSlugs: new Set(pageIndex.entries.map((e) => e.slug)),
          },
        )
      : undefined;

  const assembled = assembleMemoryGraph({
    entries: pageIndex.entries,
    staticAdjacency: staticGraph.adjacency,
    learnedAdjacency: learnedGraph?.adjacency,
  });

  return { backend: BACKEND_MEMORY_V3, supported: true, ...assembled };
}

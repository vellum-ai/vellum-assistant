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
import { getWorkspaceDir } from "../paths.js";
import { getPageIndex, type PageIndexEntry } from "../v2/page-index.js";
import { readPage, renderPageContent } from "../v2/page-store.js";
import { isSkillSlug } from "../v2/skill-store.js";
import {
  isCapabilitySlug,
  renderCapabilityContent,
} from "../v3/capabilities.js";
import { buildEdgeGraph } from "../v3/edge.js";
import { computeLearnedEdgeGraph } from "../v3/learned-edges.js";
import type { Slug } from "../v3/types.js";
import { isMemoryConceptGraphEnabled } from "./flag.js";
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
/**
 * Viz-density scaling of the retrieval lane's learned-edges thresholds. The
 * graph deliberately admits weaker co-selection associations than retrieval
 * (half the pair-count requirement, 40% of the NPMI floor, and at least
 * {@link GRAPH_LEARNED_MIN_MAX_PER_PAGE} neighbors per page) so it reads as a
 * connected web instead of scattered orphans. Retuning
 * `memory.v3.learnedEdges` for retrieval quality therefore also shifts graph
 * density — by these factors.
 */
const GRAPH_LEARNED_MIN_COUNT_FACTOR = 0.5;
const GRAPH_LEARNED_NPMI_FLOOR_FACTOR = 0.4;
const GRAPH_LEARNED_MIN_MAX_PER_PAGE = 14;

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
  if (!words) {
    return slug;
  }
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Node taxonomy tag used for coloring. Only synthetic rows (`modifiedAt: 0`)
 * are functionality: skills carry the `skills/` prefix, other synthetics (CLI
 * commands) are capabilities. A real on-disk page keeps a file mtime and is a
 * concept even when it happens to sit under a reserved prefix (e.g. a user page
 * `skills/my-notes` with no matching skill survives the page index). */
function nodeKind(entry: PageIndexEntry): string {
  if (entry.modifiedAt <= 0) {
    return isSkillSlug(entry.slug) ? "skill" : "capability";
  }
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
  /**
   * When set, drop functionality nodes (kind `skill` / `capability`) that ended
   * up with no edges — a skill nobody links to or co-selects is inert clutter.
   * Concept nodes are always kept, even when isolated.
   */
  pruneDisconnectedNonConcepts?: boolean;
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
export function assembleMemoryGraph(input: AssembleMemoryGraphInput): {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  truncated?: boolean;
} {
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
    if (!nodeIds.has(source)) {
      continue;
    }
    for (const [target, description] of out) {
      if (!nodeIds.has(target)) {
        continue;
      }
      const edge: MemoryGraphEdge = {
        source,
        target,
        kind: "link",
        directed: true,
      };
      if (description) {
        edge.description = description;
      }
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
      if (!nodeIds.has(source)) {
        continue;
      }
      for (const target of out.keys()) {
        if (!nodeIds.has(target)) {
          continue;
        }
        const key = undirectedKey(source, target);
        if (staticPairs.has(key) || emitted.has(key)) {
          continue;
        }
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
    if (entry.summary) {
      node.summary = entry.summary;
    }
    if (entry.modifiedAt > 0) {
      node.updatedAtMs = entry.modifiedAt;
    }
    return node;
  });

  // Prune disconnected functionality nodes (see the option's doc). `weight` is
  // the node's degree, so weight 0 ⇒ no incident edges ⇒ no edge cleanup needed.
  if (input.pruneDisconnectedNonConcepts) {
    nodes = nodes.filter((n) => n.kind === "concept" || (n.weight ?? 0) > 0);
  }

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
  if (!isMemoryConceptGraphEnabled(config) || !isMemoryV3Live(config)) {
    return { backend: null, supported: false, nodes: [], edges: [] };
  }

  const workspaceDir = getWorkspaceDir();
  const pageIndex = await getPageIndex(workspaceDir);
  // Concepts plus functionality (skills / CLI-command capabilities). Feeding the
  // full set to the edge builders is what lets a concept's `[[skills/foo]]` link
  // and skill↔concept co-selections resolve to real edges — buildEdgeGraph and
  // computeLearnedEdgeGraph both drop endpoints outside the set they're given.
  // Functionality nodes that end up disconnected are pruned in assembleMemoryGraph.
  const entries = pageIndex.entries;

  // Synthetic rows (skills / CLI commands) carry `modifiedAt: 0` and have no
  // on-disk page. Keyed by slug (not prefix) so a real user page that happens
  // to live under a reserved prefix is NOT mistaken for a synthetic one.
  const syntheticSlugs = new Set(
    entries.filter((e) => e.modifiedAt <= 0).map((e) => e.slug),
  );

  // Raw (frontmatter + body) page reader, matching the v3 lane build. A read
  // that rejects drops that article's authored/wikilink edges but keeps its
  // numeric fallbacks. Synthetic capability rows have no page, so short-circuit
  // their guaranteed-miss read; a real page is read so its links are captured.
  const pageRaw = async (slug: Slug): Promise<string> => {
    if (syntheticSlugs.has(slug)) {
      return "";
    }
    const page = await readPage(workspaceDir, slug);
    if (!page) {
      throw new Error(`page not found: ${slug}`);
    }
    return renderPageContent(page);
  };

  const staticGraph = await buildEdgeGraph(entries, pageRaw, {
    hubDegree: config.memory.v3.edge.hubDegree,
  });

  // Viz-tuned learned edges (see the GRAPH_LEARNED_* constants): this endpoint
  // is visualization-only, so surfacing weaker co-selection associations (and a
  // little extra edge noise) is a fair trade. Floors keep the thresholds sane
  // even when the retrieval config is aggressive or disables the lane.
  const learned = config.memory.v3.learnedEdges;
  const learnedGraph = computeLearnedEdgeGraph(
    { db: getDb() },
    {
      halfLifeMs: learned.halfLifeDays * DAY_MS,
      minCount: Math.max(1, learned.minCount * GRAPH_LEARNED_MIN_COUNT_FACTOR),
      npmiFloor: Math.max(
        0,
        learned.npmiFloor * GRAPH_LEARNED_NPMI_FLOOR_FACTOR,
      ),
      maxPerPage: Math.max(learned.maxPerPage, GRAPH_LEARNED_MIN_MAX_PER_PAGE),
      now: Date.now(),
      windowMs: LEARNED_EDGES_WINDOW_DAYS * DAY_MS,
      knownSlugs: new Set(entries.map((e) => e.slug)),
    },
  );

  const assembled = assembleMemoryGraph({
    entries,
    staticAdjacency: staticGraph.adjacency,
    learnedAdjacency: learnedGraph.adjacency,
    pruneDisconnectedNonConcepts: true,
  });

  return { backend: BACKEND_MEMORY_V3, supported: true, ...assembled };
}

/**
 * Fetch a single node's content by id. Used when a user opens a node in the
 * graph. Concept nodes return their page's markdown body; functionality nodes
 * (skills / CLI commands) return the rendered capability statement. Unknown or
 * unreadable ids return `{ found: false }`.
 */
export async function getMemoryGraphNode(
  config: AssistantConfig,
  id: string,
): Promise<MemoryGraphNodeDetail> {
  if (!isMemoryConceptGraphEnabled(config) || !isMemoryV3Live(config) || !id) {
    return { found: false };
  }
  // Seeded skill/CLI capabilities take precedence over any on-disk page at the
  // same slug: the page index drops a colliding page and lets the synthetic win
  // (v2/page-index.ts), so a `skills/foo` node built as the capability must not
  // surface a stale disk page. renderCapabilityContent returns the rendered
  // statement for a seeded capability, "" for an unseeded reserved-prefix slug
  // (a real user page), and null for a normal concept slug.
  if (isCapabilitySlug(id)) {
    const content = renderCapabilityContent(id);
    if (content) {
      return { found: true, title: humanizeSlug(id), content };
    }
  }
  // A real on-disk page: a concept, or a user page under a reserved prefix that
  // isn't a seeded capability (kept in the index with a real mtime).
  const page = await readPage(getWorkspaceDir(), id).catch(() => null);
  if (page) {
    return { found: true, title: humanizeSlug(id), content: page.body };
  }
  return { found: false };
}

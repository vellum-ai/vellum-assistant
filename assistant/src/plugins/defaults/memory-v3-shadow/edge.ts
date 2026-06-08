import type { PageIndexEntry } from "../../../memory/v2/page-index.js";
import { parseFrontmatterFields } from "../../../skills/frontmatter.js";
import type { Slug } from "./types.js";

/**
 * Edge lane for memory-v3 retrieval: a directed article link-graph used to
 * expand a turn's lexical/dense seeds outward to their first-class neighbours.
 *
 * The graph unions THREE outbound-edge sources per article:
 *
 *   (a) The optional `links:` frontmatter — a YAML list of
 *       `"<target-slug> — <description>"` strings (split on the first
 *       ` — `, space-emdash-space). This is the authored, first-class edge
 *       source: the curated description is carried through expansion so the
 *       orchestrator can use it directly as a select descriptor.
 *   (b) Inline `[[wikilink]]` targets parsed from the body.
 *   (c) `PageIndexEntry.edges` numeric ids resolved to slugs — the fallback
 *       for pages with no frontmatter `links`.
 *
 * All targets are resolved against the corpus slug set; unknown/dangling
 * targets are dropped. A curated description is stored per (source → target)
 * edge only when the `links` source supplied one; wikilink/numeric edges carry
 * no description (the orchestrator falls back to a section descriptor).
 *
 * The build is pure given a `pageRaw` reader callback (no hard-coded I/O), so
 * it is built once at lane-init and rebuilt by the maintain job, and is
 * trivially unit-testable with a stub reader.
 */

/** Default in-degree above which an article is treated as a hub and excluded
 * from expansion (a hub neighbour is too generic to be a useful surface). */
const DEFAULT_HUB_DEGREE = 30;

const DEFAULT_SEED_COUNT = 18;
const DEFAULT_PER_SEED = 6;
const DEFAULT_CAP = 45;

/** Matches the space-emdash-space separator in a `links:` entry. */
const LINK_SEPARATOR = " — ";

/** Matches `[[target]]` wikilinks; captures the raw target before any `|`
 * display-text or `#section` anchor. */
const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

/**
 * The directed link-graph. `adjacency` maps each source slug to its outbound
 * edges (target slug → curated description, or `undefined` when the edge came
 * from a wikilink/numeric source). `hubs` is the set of high-in-degree slugs
 * excluded from expansion. `slugs` is the resolved corpus slug set.
 */
export interface EdgeGraph {
  adjacency: Map<Slug, Map<Slug, string | undefined>>;
  hubs: Set<Slug>;
  slugs: Set<Slug>;
}

/** One article surfaced by {@link edgeExpand}, with the curated `links`
 * description of the traversed edge when it carried one (else `undefined`). */
export interface EdgeNeighbor {
  article: Slug;
  description?: string;
}

export interface EdgeExpandOptions {
  /** Predicate gating which neighbours may be surfaced (e.g. liveness /
   * not-already-selected). Neighbours failing `alive` are skipped. */
  alive?: (slug: Slug) => boolean;
  /** Only the top `seedCount` seeds (in input order) are expanded. */
  seedCount?: number;
  /** Up to `perSeed` neighbours are added per expanded seed. */
  perSeed?: number;
  /** Hard cap on the total number of distinct surfaced articles. */
  cap?: number;
}

interface BuildEdgeGraphOptions {
  /** In-degree above which an article is a hub. Defaults to
   * {@link DEFAULT_HUB_DEGREE}. */
  hubDegree?: number;
}

/**
 * Split one `links:` entry (`"<target-slug> — <description>"`) into its target
 * slug and curated description on the FIRST ` — ` (space-emdash-space).
 * Entries with no separator are bare target slugs and carry no description.
 */
function parseLinkEntry(entry: string): {
  target: Slug;
  description: string | undefined;
} {
  const sep = entry.indexOf(LINK_SEPARATOR);
  if (sep === -1) return { target: entry.trim(), description: undefined };
  return {
    target: entry.slice(0, sep).trim(),
    description: entry.slice(sep + LINK_SEPARATOR.length).trim() || undefined,
  };
}

/** Parse inline `[[wikilink]]` targets from a body. Strips `|display` and
 * `#anchor` suffixes; returns trimmed target slugs (possibly with duplicates,
 * deduped by the caller's map insertion). */
function parseWikilinks(body: string): string[] {
  const targets: string[] = [];
  for (const match of body.matchAll(WIKILINK_REGEX)) {
    let target = match[1];
    const pipe = target.indexOf("|");
    if (pipe !== -1) target = target.slice(0, pipe);
    const hash = target.indexOf("#");
    if (hash !== -1) target = target.slice(0, hash);
    target = target.trim();
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Build the directed article link-graph from the page-index entries and a raw
 * page reader. See the module docstring for the three unioned edge sources.
 *
 * Pure given `pageRaw`: the build performs no hard-coded I/O. A read that
 * rejects drops that article's authored/wikilink edges but still keeps its
 * numeric `PageIndexEntry.edges` fallback.
 */
export async function buildEdgeGraph(
  articles: readonly PageIndexEntry[],
  pageRaw: (slug: Slug) => Promise<string>,
  opts: BuildEdgeGraphOptions = {},
): Promise<EdgeGraph> {
  const hubDegree = opts.hubDegree ?? DEFAULT_HUB_DEGREE;

  const slugs = new Set<Slug>(articles.map((a) => a.slug));
  const byId = new Map<number, Slug>(articles.map((a) => [a.id, a.slug]));

  const raws = await Promise.all(
    articles.map((a) =>
      pageRaw(a.slug).then(
        (text) => text,
        () => null, // read failed — fall back to numeric edges only
      ),
    ),
  );

  const adjacency = new Map<Slug, Map<Slug, string | undefined>>();
  const inDegree = new Map<Slug, number>();

  const addEdge = (
    source: Slug,
    target: Slug,
    description: string | undefined,
  ): void => {
    if (target === source) return; // no self-edges
    if (!slugs.has(target)) return; // drop unknown/dangling targets
    let out = adjacency.get(source);
    if (!out) {
      out = new Map();
      adjacency.set(source, out);
    }
    if (!out.has(target)) {
      out.set(target, description);
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    } else if (out.get(target) === undefined && description !== undefined) {
      // A later source (the authored `links`) supplies a description for an
      // edge first seen without one — upgrade it. In-degree already counted.
      out.set(target, description);
    }
  };

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const source = article.slug;
    const raw = raws[i];

    // (a) authored `links:` frontmatter — primary, carries descriptions.
    const parsed = raw !== null ? parseFrontmatterFields(raw) : null;
    const links = parsed?.fields.links;
    if (Array.isArray(links)) {
      for (const entry of links) {
        if (typeof entry !== "string") continue;
        const { target, description } = parseLinkEntry(entry);
        addEdge(source, target, description);
      }
    }

    // (b) inline `[[wikilink]]` targets from the body. `parsed.body` strips
    // the frontmatter; a page without frontmatter has `parsed === null`, so
    // the whole raw text is the body.
    const body = parsed ? parsed.body : raw;
    if (body !== null) {
      for (const target of parseWikilinks(body)) {
        addEdge(source, target, undefined);
      }
    }

    // (c) numeric page-index edges resolved to slugs — fallback.
    for (const targetId of article.edges) {
      const target = byId.get(targetId);
      if (target) addEdge(source, target, undefined);
    }
  }

  const hubs = new Set<Slug>();
  for (const [slug, degree] of inDegree) {
    if (degree > hubDegree) hubs.add(slug);
  }

  return { adjacency, hubs, slugs };
}

/**
 * Expand `seeds` outward along the graph. For each of the top `seedCount`
 * seeds (in input order), surface up to `perSeed` non-hub, `alive`-passing
 * neighbours, capped at `cap` total distinct articles. Seeds themselves are
 * not surfaced (they are already in the pool). Each surfaced article carries
 * the curated `links` description of the traversed edge when it had one.
 *
 * Deterministic given the input seed order and the graph's insertion order.
 */
export function edgeExpand(
  graph: EdgeGraph,
  seeds: readonly Slug[],
  opts: EdgeExpandOptions = {},
): EdgeNeighbor[] {
  const seedCount = opts.seedCount ?? DEFAULT_SEED_COUNT;
  const perSeed = opts.perSeed ?? DEFAULT_PER_SEED;
  const cap = opts.cap ?? DEFAULT_CAP;
  const alive = opts.alive;

  const seedSet = new Set<Slug>(seeds);
  const surfaced = new Map<Slug, string | undefined>();

  for (const seed of seeds.slice(0, seedCount)) {
    if (surfaced.size >= cap) break;
    const out = graph.adjacency.get(seed);
    if (!out) continue;
    let added = 0;
    for (const [target, description] of out) {
      if (added >= perSeed) break;
      if (surfaced.size >= cap) break;
      if (seedSet.has(target)) continue; // already in the pool
      if (surfaced.has(target)) continue; // already surfaced via another seed
      if (graph.hubs.has(target)) continue; // hubs excluded
      if (alive && !alive(target)) continue;
      surfaced.set(target, description);
      added++;
    }
  }

  return [...surfaced].map(([article, description]) => ({
    article,
    description,
  }));
}

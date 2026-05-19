/**
 * Memory v2 — Numbered page index for the router prompt.
 *
 * Renders a compact catalog of every concept page plus every seeded skill
 * entry, sorted by slug ASCII for deterministic IDs, with each entry's
 * outgoing edges resolved to numeric IDs. The router prompt consumes the
 * pre-rendered block to choose which slugs to activate per turn.
 *
 * Skill entries (those in the `skills/<id>` namespace) participate alongside
 * concept pages so the router can reach them through the same mechanism.
 * Skill entries always have `edges: []` — the cross-page edge graph is a
 * concept-page-only construct.
 *
 * The build is cached module-locally per `workspaceDir`, mirroring
 * `edge-index.ts`. Callers must invalidate via `invalidatePageIndex` when
 * concept pages or seeded skill entries change.
 */

import { getLogger } from "../../util/logger.js";
import { listPages, readPage } from "./page-store.js";

// Dynamic import for `./skill-store.js` happens inside `getPageIndex` so that
// modules that only need `invalidatePageIndex` (page-store.ts,
// tool-side-effects.ts) don't transitively pull in the embedding-backend
// chain via skill-store. Loading it at call time keeps the invalidation hook
// cheap and avoids cross-module import cycles in tests that mock jobs-store
// or embedding-backend.

const log = getLogger("memory-v2-page-index");

const SUMMARY_MAX_LENGTH = 200;

/**
 * Collapse every run of whitespace (including embedded newlines and tabs) to a
 * single space and trim. The router prompt renders one entry per line, so an
 * embedded newline anywhere in `summary` would split that entry across lines
 * and corrupt the format the router parses.
 */
function normalizeSummary(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX_LENGTH);
}

/**
 * One row in the rendered page index. `id` is a 1-based dense integer that is
 * stable within a single index version (i.e. a single build). It changes when
 * the index is rebuilt because IDs are derived from the slug-sorted position;
 * callers must not persist them across builds.
 */
export interface PageIndexEntry {
  /** 1-based dense numeric id, stable within an index version. */
  id: number;
  /** Concept-page slug or `skills/<id>`. */
  slug: string;
  /** Truncated to {@link SUMMARY_MAX_LENGTH} characters. */
  summary: string;
  /** Numeric IDs of outgoing edges, in sorted order. */
  edges: number[];
}

/**
 * Snapshot of the page index for one workspace. `entries` is sorted by slug
 * ASCII so IDs are deterministic across rebuilds with the same input. The
 * `bySlug` and `byId` maps are convenience lookups; `rendered` is the prompt
 * block consumed by the router.
 */
export interface PageIndex {
  entries: PageIndexEntry[];
  bySlug: Map<string, PageIndexEntry>;
  byId: Map<number, PageIndexEntry>;
  rendered: string;
}

interface CachedIndex {
  workspaceDir: string;
  index: PageIndex;
}

let cache: CachedIndex | null = null;

/**
 * Return a `PageIndex` for `workspaceDir`. Cached module-locally; the cache
 * is invalidated by `invalidatePageIndex` (called by daemon-side hooks when
 * concept pages, skill entries, or CLI-command entries change).
 *
 * Cold builds list every concept page in parallel, drop pages whose read
 * rejects, append seeded skill entries from `listSkillEntries()` and CLI
 * command entries from `listCliCommandEntries()`, sort by slug for
 * deterministic IDs, then resolve outgoing edges to numeric IDs.
 */
export async function getPageIndex(workspaceDir: string): Promise<PageIndex> {
  if (cache && cache.workspaceDir === workspaceDir) {
    return cache.index;
  }

  const slugs = await listPages(workspaceDir);

  // Read pages in parallel; pages whose read rejects are dropped with a warn
  // so a single broken page never blocks the rest of the index.
  const settled = await Promise.allSettled(
    slugs.map((slug) => readPage(workspaceDir, slug)),
  );

  // Intermediate shape used while we still need the raw outgoing slugs to
  // resolve into numeric IDs after sorting.
  interface DraftEntry {
    slug: string;
    summary: string;
    outgoingSlugs: string[];
  }

  const [
    { listSkillEntries, SKILL_SLUG_PREFIX },
    { listCliCommandEntries, CLI_COMMAND_SLUG_PREFIX },
  ] = await Promise.all([
    import("./skill-store.js"),
    import("./cli-command-store.js"),
  ]);

  // Build the synthetic-slug sets first so we can drop colliding concept
  // pages. Collision policy: **synthetic entries win**. Skill and CLI rows
  // are seeded from authoritative in-process catalogs; a hand-authored page
  // sitting under `skills/<id>` or `cli-commands/<name>` is either a stale
  // leftover from a prior write or a user mistake. `bySlug` is last-writer-
  // wins, so without explicit dedupe one side would silently shadow the
  // other depending on iteration order.
  const skillEntries = listSkillEntries();
  const skillSlugs = new Set(
    skillEntries.map((entry) => `${SKILL_SLUG_PREFIX}${entry.id}`),
  );
  const cliCommandEntries = listCliCommandEntries();
  const cliCommandSlugs = new Set(
    cliCommandEntries.map((entry) => `${CLI_COMMAND_SLUG_PREFIX}${entry.id}`),
  );

  const drafts: DraftEntry[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const slug = slugs[i];
    if (result.status === "rejected") {
      log.warn(
        { slug, err: result.reason },
        "Dropping concept page from index — read failed",
      );
      continue;
    }
    const page = result.value;
    if (!page) continue;
    if (skillSlugs.has(slug)) {
      log.warn(
        { slug },
        "Dropping concept page from index — slug collides with a seeded skill entry; skill wins",
      );
      continue;
    }
    if (cliCommandSlugs.has(slug)) {
      log.warn(
        { slug },
        "Dropping concept page from index — slug collides with a seeded CLI-command entry; CLI command wins",
      );
      continue;
    }
    const summarySource = page.frontmatter.summary?.trim() || page.body.trim();
    drafts.push({
      slug,
      summary: normalizeSummary(summarySource),
      outgoingSlugs: page.frontmatter.edges,
    });
  }

  for (const entry of skillEntries) {
    drafts.push({
      slug: `${SKILL_SLUG_PREFIX}${entry.id}`,
      summary: normalizeSummary(entry.content),
      outgoingSlugs: [],
    });
  }

  for (const entry of cliCommandEntries) {
    drafts.push({
      slug: `${CLI_COMMAND_SLUG_PREFIX}${entry.id}`,
      summary: normalizeSummary(entry.description),
      outgoingSlugs: [],
    });
  }

  drafts.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // Assign 1-based dense IDs in sort order so entries[i].id === i + 1.
  const bySlug = new Map<string, PageIndexEntry>();
  const byId = new Map<number, PageIndexEntry>();
  const entries: PageIndexEntry[] = drafts.map((draft, i) => {
    const entry: PageIndexEntry = {
      id: i + 1,
      slug: draft.slug,
      summary: draft.summary,
      edges: [],
    };
    bySlug.set(entry.slug, entry);
    byId.set(entry.id, entry);
    return entry;
  });

  // Edges whose target slug isn't in the index are dropped silently — the
  // frontmatter sweep is responsible for surfacing those as warnings.
  for (let i = 0; i < entries.length; i++) {
    const draft = drafts[i];
    const resolved: number[] = [];
    for (const targetSlug of draft.outgoingSlugs) {
      const target = bySlug.get(targetSlug);
      if (target) resolved.push(target.id);
    }
    resolved.sort((a, b) => a - b);
    entries[i].edges = resolved;
  }

  const rendered = renderIndex(entries);
  const index: PageIndex = { entries, bySlug, byId, rendered };
  cache = { workspaceDir, index };
  return index;
}

/**
 * Clear the cached index. Pass `workspaceDir` to scope invalidation to a
 * specific cache entry; omit it to clear unconditionally.
 */
export function invalidatePageIndex(workspaceDir?: string): void {
  if (!cache) return;
  if (workspaceDir === undefined || cache.workspaceDir === workspaceDir) {
    cache = null;
  }
}

/**
 * Render the prompt block: one line per entry shaped
 * `[id] slug — summary (edges: a, b, c)`. Lines without outgoing edges drop
 * the parenthetical entirely. Trailing newline so the block can be
 * concatenated into a larger prompt without manual padding.
 */
function renderIndex(entries: readonly PageIndexEntry[]): string {
  const lines = entries.map((entry) => {
    const head = `[${entry.id}] ${entry.slug} — ${entry.summary}`;
    if (entry.edges.length === 0) return head;
    return `${head} (edges: ${entry.edges.join(", ")})`;
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

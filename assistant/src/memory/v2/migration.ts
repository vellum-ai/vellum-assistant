/**
 * Memory v2 — One-shot v1→v2 migration.
 *
 * Gathers v1 graph nodes plus PKB markdown content, clusters them by topic,
 * synthesizes a concept page per cluster via the configured LLM, promotes
 * high-significance nodes to `essentials.md` / active follow-ups to
 * `threads.md` / low-significance episodes to `archive/migrated-<date>.md`,
 * preserves v1 weighted directional edges as outgoing-edge entries on each
 * source page's frontmatter, and enqueues `embed_concept_page` jobs for each
 * new page. A sentinel file at `memory/.v2-state/.migration-complete-v1-to-v2`
 * gates re-runs — `force: true` is required to overwrite.
 *
 * The migration is structured as a sequence of small helpers — `gatherV1State`,
 * `clusterByTopic`, `synthesizeConceptPage`, `derivePromotions`,
 * `collapseEdges`, `enqueueEmbeds` — each individually testable so the live
 * LLM never has to be invoked from the unit suite. `runMemoryV2Migration`
 * threads them together and writes the sentinel on success.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssistantConfig } from "../../config/types.js";
import {
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type { Provider } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { enqueueMemoryJob } from "../jobs-store.js";
import { slugify, writePage } from "./page-store.js";
import type { ConceptPage } from "./types.js";

const log = getLogger("memory-v2-migration");

/** Sentinel file written when the v1→v2 migration completes successfully. */
export const MIGRATION_SENTINEL_RELATIVE = join(
  "memory",
  ".v2-state",
  ".migration-complete-v1-to-v2",
);

/**
 * Result returned by `runMemoryV2Migration`. Counts every meaningful
 * side-effect so the caller (CLI, IPC route, tests) can surface a useful
 * summary without having to re-walk the workspace.
 */
export interface MigrationResult {
  pagesCreated: number;
  edgesWritten: number;
  essentialsLines: number;
  threadsLines: number;
  archiveLines: number;
  embedsEnqueued: number;
  sentinelWritten: boolean;
}

// ---------------------------------------------------------------------------
// Stage 1 — Gather v1 state
// ---------------------------------------------------------------------------

/**
 * v1 source item — either a graph node or a PKB markdown chunk. The shape is
 * intentionally narrow: each stage only needs `id` (for stable identity),
 * `text` (for clustering + synthesis), and the structural fields that drive
 * promotion decisions (`significance`, `type`, `eventDate`).
 */
export interface V1Item {
  id: string;
  text: string;
  /** v1 source bucket — drives clustering fallback and promotion decisions. */
  source: "graph_node" | "pkb_buffer" | "pkb_archive" | "pkb_topic";
  /** Significance in [0, 1] for graph nodes; 0 for PKB items. */
  significance: number;
  /** Memory type for graph nodes; null for PKB items. */
  type: string | null;
  /** Epoch ms; null when unknown. */
  eventDate: number | null;
  /** Source filename (relative to workspace root) for PKB items; null for graph nodes. */
  sourcePath: string | null;
}

/**
 * v1 weighted directional edge. v2 preserves direction (an edge A→B in v1
 * becomes an outgoing-edge entry on A's page in v2), so the migration just
 * has to map node ids to slugs and group by source.
 */
export interface V1Edge {
  sourceNodeId: string;
  targetNodeId: string;
}

/**
 * Read every `memory_graph_nodes` row, every `memory_graph_edges` row, and
 * every `pkb/` markdown file inside `workspaceDir`. PKB files that don't
 * exist on disk are silently skipped — a fresh workspace with no PKB content
 * still migrates cleanly (it just produces no concept pages).
 */
export function gatherV1State(
  database: DrizzleDb,
  workspaceDir: string,
): { items: V1Item[]; edges: V1Edge[] } {
  const items: V1Item[] = [];
  const raw = getSqliteFrom(database);

  // -- Graph nodes --
  // Use a raw SELECT so this module stays decoupled from the v1 graph-store
  // domain layer (which v2 will eventually replace). We only need id /
  // content / type / significance / event_date — everything else is unused
  // by the migration.
  const nodeRows = raw
    .query<
      {
        id: string;
        content: string;
        type: string;
        significance: number;
        event_date: number | null;
      },
      []
    >(
      /*sql*/ `SELECT id, content, type, significance, event_date FROM memory_graph_nodes`,
    )
    .all();
  for (const row of nodeRows) {
    items.push({
      id: row.id,
      text: row.content,
      source: "graph_node",
      significance: row.significance,
      type: row.type,
      eventDate: row.event_date,
      sourcePath: null,
    });
  }

  // -- Graph edges --
  const edgeRows = raw
    .query<
      { source_node_id: string; target_node_id: string },
      []
    >(/*sql*/ `SELECT source_node_id, target_node_id FROM memory_graph_edges`)
    .all();
  const edges: V1Edge[] = edgeRows.map((row) => ({
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
  }));

  // -- PKB content --
  const pkbDir = join(workspaceDir, "pkb");
  if (existsSync(pkbDir)) {
    items.push(...readPkbItems(pkbDir));
  }

  return { items, edges };
}

/**
 * Walk `pkbDir` once and emit a `V1Item` per markdown file. Sub-buckets:
 *
 *   - `buffer.md` (top-level) → `pkb_buffer`
 *   - `archive/*.md`          → `pkb_archive`
 *   - everything else `*.md`  → `pkb_topic`
 *
 * We deliberately read the full file rather than chunking — the LLM in stage
 * 3 will summarize, and the upstream PKB chunker is overkill here.
 */
function readPkbItems(pkbDir: string): V1Item[] {
  const items: V1Item[] = [];

  const bufferPath = join(pkbDir, "buffer.md");
  if (existsSync(bufferPath)) {
    items.push({
      id: "pkb:buffer",
      text: readFileSync(bufferPath, "utf-8"),
      source: "pkb_buffer",
      significance: 0,
      type: null,
      eventDate: null,
      sourcePath: "pkb/buffer.md",
    });
  }

  const archiveDir = join(pkbDir, "archive");
  if (existsSync(archiveDir)) {
    for (const name of readdirSync(archiveDir).sort()) {
      if (!name.endsWith(".md")) continue;
      items.push({
        id: `pkb:archive:${name}`,
        text: readFileSync(join(archiveDir, name), "utf-8"),
        source: "pkb_archive",
        significance: 0,
        type: null,
        eventDate: null,
        sourcePath: join("pkb", "archive", name),
      });
    }
  }

  // Topic files — anything else at the top level besides buffer.md.
  for (const name of readdirSync(pkbDir).sort()) {
    if (!name.endsWith(".md")) continue;
    if (name === "buffer.md") continue;
    items.push({
      id: `pkb:topic:${name}`,
      text: readFileSync(join(pkbDir, name), "utf-8"),
      source: "pkb_topic",
      significance: 0,
      type: null,
      eventDate: null,
      sourcePath: join("pkb", name),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Stage 2 — Cluster by topic
// ---------------------------------------------------------------------------

/**
 * One proposed concept page. `slugHint` seeds `slugify` in stage 3 — the
 * synthesizer is free to refine it but always produces *some* slug.
 */
export interface Cluster {
  slugHint: string;
  items: V1Item[];
}

/**
 * Group v1 items into proposed concept pages.
 *
 * The heuristic is intentionally simple — embedding-cluster is on the
 * "follow-up improvements" list (see plan §11), but for the v1-of-v2 cutover
 * file-based grouping for PKB plus per-graph-node singletons gives a
 * reasonable starting set that the LLM can refine in stage 3:
 *
 *   - Each `pkb_topic` file becomes its own cluster (slug derived from
 *     filename — that's literally what topic files were already keyed on).
 *   - `pkb_buffer` and every `pkb_archive` entry becomes its own cluster
 *     (these are timeline-style; no obvious topic to merge on).
 *   - Each graph node is its own cluster (the LLM call in stage 3 already
 *     synthesizes prose; merging duplicates is consolidation's job).
 *
 * The output is deterministic: clusters are emitted in iteration order of
 * the input items, which matches the SELECT order from `gatherV1State`.
 */
export function clusterByTopic(items: V1Item[]): Cluster[] {
  return items.map((item) => ({
    slugHint: deriveSlugHint(item),
    items: [item],
  }));
}

/**
 * Pick a slug seed for a single v1 item. PKB topic files use their filename
 * (sans `.md`); archive entries use the date stamp; graph nodes use the
 * first ~6 words of the content. `slugify` enforces ASCII / kebab-case /
 * length cap downstream so we don't have to.
 */
function deriveSlugHint(item: V1Item): string {
  if (item.source === "pkb_topic" && item.sourcePath) {
    const base = item.sourcePath.split("/").pop() ?? "";
    return base.replace(/\.md$/, "");
  }
  if (item.source === "pkb_archive" && item.sourcePath) {
    return `archive-${item.sourcePath.split("/").pop()?.replace(/\.md$/, "")}`;
  }
  if (item.source === "pkb_buffer") {
    return "pkb-buffer";
  }
  // graph_node — first few words of the content.
  return item.text.split(/\s+/).slice(0, 6).join("-");
}

// ---------------------------------------------------------------------------
// Stage 3 — Synthesize a concept page per cluster
// ---------------------------------------------------------------------------

/**
 * Synthesis prompt — kept here (rather than under `prompts/`) because it's
 * only used by the migration. The model is asked to emit prose only; the
 * frontmatter is filled in deterministically by the caller.
 */
const SYNTHESIS_SYSTEM_PROMPT = `You are migrating an assistant's memory from a legacy graph + PKB store to a v2 concept-page store. For each cluster of v1 source items, write a single concept page in first-person prose, in the assistant's voice. Do NOT include YAML frontmatter — the caller will add it. Do NOT include a title heading — the slug filename is the title. Keep the body under 5000 characters. Stay grounded in the source items; do not invent facts.`;

/**
 * Synthesize a single concept page from a `Cluster`. Calls the configured
 * provider via `memoryV2Migration` LLMCallSite. The body is the model's
 * response text; the slug is derived from the cluster's `slugHint`.
 *
 * `provider` is injected so unit tests can pass a stub. Production callers
 * pass the result of `getConfiguredProvider("memoryV2Migration")`.
 *
 * `identityContext` (typically the assistant's SOUL.md / IDENTITY.md
 * concatenation) is appended to the system prompt so the synthesized prose
 * sounds like the assistant rather than a generic narrator.
 */
export async function synthesizeConceptPage(
  cluster: Cluster,
  identityContext: string | null,
  provider: Provider,
): Promise<ConceptPage> {
  const sourceListing = cluster.items
    .map((item, i) => {
      const tag =
        item.source === "graph_node"
          ? `node ${item.id} (type=${item.type ?? "?"}, sig=${item.significance.toFixed(2)})`
          : (item.sourcePath ?? item.source);
      return `### Source ${i + 1} [${tag}]\n${item.text.trim()}`;
    })
    .join("\n\n");

  const systemPrompt = identityContext
    ? `${SYNTHESIS_SYSTEM_PROMPT}\n\n## Assistant identity\n${identityContext}`
    : SYNTHESIS_SYSTEM_PROMPT;

  const response = await provider.sendMessage(
    [
      userMessage(
        `Synthesize a single concept page from these v1 sources. Slug hint: \`${cluster.slugHint}\`.\n\n${sourceListing}`,
      ),
    ],
    [],
    systemPrompt,
    { config: { callSite: "memoryV2Migration" as const } },
  );
  const body = extractText(response);

  return {
    slug: slugify(cluster.slugHint),
    frontmatter: { edges: [], ref_files: [] },
    body: body.endsWith("\n") ? body : `${body}\n`,
  };
}

// ---------------------------------------------------------------------------
// Stage 4 — Derive essentials / threads / archive promotions
// ---------------------------------------------------------------------------

/**
 * Bucketed promotions written to the prose files in `memory/`. The runner
 * appends each bucket to its target file (rather than overwriting) so an
 * operator running `--force` keeps any hand-edits the assistant has made
 * since the last migration.
 */
export interface Promotions {
  /** Lines for `memory/essentials.md`. */
  essentials: string[];
  /** Lines for `memory/threads.md`. */
  threads: string[];
  /** Lines for `memory/archive/migrated-<date>.md`. */
  archive: string[];
}

/** Cutoff above which a graph node is treated as essential. */
const ESSENTIALS_SIGNIFICANCE_THRESHOLD = 0.85;
/** Cutoff below which a graph node is bucketed as low-significance episodic. */
const ARCHIVE_SIGNIFICANCE_THRESHOLD = 0.3;

/**
 * Decide which v1 graph nodes get promoted to which prose file. PKB items
 * are always synthesized into concept pages — they don't get a separate
 * prose-file promotion.
 *
 *   - significance >= 0.85         → `essentials.md`
 *   - type == "prospective"        → `threads.md`
 *   - significance <= 0.3          → archive
 *   - everything else              → no promotion (only the synthesized page)
 *
 * The thresholds are intentionally chunky — fine-tuning happens during
 * consolidation, not here.
 */
export function derivePromotions(items: V1Item[]): Promotions {
  const essentials: string[] = [];
  const threads: string[] = [];
  const archive: string[] = [];

  for (const item of items) {
    if (item.source !== "graph_node") continue;

    const summary = formatPromotionLine(item);
    if (item.significance >= ESSENTIALS_SIGNIFICANCE_THRESHOLD) {
      essentials.push(summary);
      continue;
    }
    if (item.type === "prospective") {
      threads.push(summary);
      continue;
    }
    if (item.significance <= ARCHIVE_SIGNIFICANCE_THRESHOLD) {
      archive.push(summary);
    }
  }

  return { essentials, threads, archive };
}

/** Format a single graph node as a one-line bullet for the prose files. */
function formatPromotionLine(item: V1Item): string {
  // Strip newlines so each item becomes a single bullet.
  const text = item.text.replace(/\s+/g, " ").trim();
  return `- ${text}`;
}

// ---------------------------------------------------------------------------
// Stage 5 — Map v1 edges to per-page outgoing edges
// ---------------------------------------------------------------------------

/**
 * Map every v1 graph-node id to a v2 concept-page slug and group v1 edges by
 * source slug. Edges with either endpoint missing from `slugMap` are dropped
 * silently — those endpoints didn't survive synthesis (e.g. their cluster
 * produced no usable page). Self-loops are dropped; duplicate `(source, target)`
 * pairs collapse via the `Set<string>`.
 *
 * The returned map keys are source slugs and the values are sets of target
 * slugs — i.e. each entry is a page's outgoing-edge list. The runner writes
 * these into the source page's frontmatter.
 */
export function collapseEdges(
  v1Edges: V1Edge[],
  slugMap: Map<string, string>,
): Map<string, Set<string>> {
  const outgoing = new Map<string, Set<string>>();
  for (const edge of v1Edges) {
    const from = slugMap.get(edge.sourceNodeId);
    const to = slugMap.get(edge.targetNodeId);
    if (!from || !to) continue;
    if (from === to) continue;
    let targets = outgoing.get(from);
    if (!targets) {
      targets = new Set<string>();
      outgoing.set(from, targets);
    }
    targets.add(to);
  }
  return outgoing;
}

// ---------------------------------------------------------------------------
// Stage 6 — Fan out embed jobs
// ---------------------------------------------------------------------------

/**
 * Enqueue an `embed_concept_page` job for each newly-written slug. The job
 * itself lands in PR 13 — we just stage the queue here, so the embeddings
 * are ready by the time activation needs them.
 */
export function enqueueEmbeds(slugs: string[]): number {
  for (const slug of slugs) {
    enqueueMemoryJob("embed_concept_page", { slug });
  }
  return slugs.length;
}

// ---------------------------------------------------------------------------
// Top-level migration runner
// ---------------------------------------------------------------------------

export interface RunMemoryV2MigrationParams {
  workspaceDir: string;
  database: DrizzleDb;
  /** Overwrite existing v2 state when the sentinel is already present. */
  force?: boolean;
  /** Identity context appended to the synthesis system prompt. */
  identityContext?: string | null;
  /** Caller-supplied LLM provider for synthesis. Defaults to the configured provider. */
  provider?: Provider;
  /** Caller-supplied config; reserved for future tunables (e.g. cluster knobs). */
  config?: AssistantConfig;
}

/**
 * Run the full v1→v2 migration. Returns a `MigrationResult` summarizing
 * every side-effect for the CLI / IPC caller.
 *
 * Re-runs are gated by the sentinel file
 * `memory/.v2-state/.migration-complete-v1-to-v2`. Without `force: true`, a
 * second invocation throws `MigrationAlreadyAppliedError` without mutating
 * anything; with `force: true`, the migration overwrites pages and re-appends
 * to the prose files.
 */
export class MigrationAlreadyAppliedError extends Error {
  constructor() {
    super(
      "Memory v2 migration sentinel exists; pass force: true to re-run. Running without --force preserves the existing v2 state.",
    );
    this.name = "MigrationAlreadyAppliedError";
  }
}

export async function runMemoryV2Migration(
  params: RunMemoryV2MigrationParams,
): Promise<MigrationResult> {
  const {
    workspaceDir,
    database,
    force = false,
    identityContext = null,
  } = params;

  const sentinelPath = join(workspaceDir, MIGRATION_SENTINEL_RELATIVE);
  if (existsSync(sentinelPath) && !force) {
    throw new MigrationAlreadyAppliedError();
  }

  const { items, edges: v1Edges } = gatherV1State(database, workspaceDir);
  log.info(
    { itemCount: items.length, edgeCount: v1Edges.length },
    "Gathered v1 state for memory v2 migration",
  );

  const clusters = clusterByTopic(items);

  const provider =
    params.provider ?? (await getConfiguredProvider("memoryV2Migration"));
  if (!provider) {
    throw new Error(
      "memoryV2Migration provider unavailable — configure llm.callSites.memoryV2Migration or llm.default before re-running.",
    );
  }

  // PKB items never become edge endpoints, so the slug map only needs the
  // graph-node side of the cluster.
  const slugMap = new Map<string, string>();
  const pages: ConceptPage[] = [];
  const usedSlugs = new Set<string>();

  for (const cluster of clusters) {
    const page = await synthesizeConceptPage(
      cluster,
      identityContext,
      provider,
    );
    // Disambiguate slug collisions deterministically: append `-2`, `-3`, …
    // until we find an unused slug. Keeps synthesizeConceptPage stateless
    // while still tolerating two clusters that hash to the same hint.
    let finalSlug = page.slug;
    let suffix = 2;
    while (usedSlugs.has(finalSlug)) {
      finalSlug = `${page.slug}-${suffix++}`;
    }
    usedSlugs.add(finalSlug);
    const finalized: ConceptPage = { ...page, slug: finalSlug };
    pages.push(finalized);

    for (const item of cluster.items) {
      if (item.source === "graph_node") slugMap.set(item.id, finalSlug);
    }
  }

  // Resolve outgoing edges per source slug, then attach them to each page's
  // frontmatter before writing. The page is the source of truth for its own
  // outgoing edges — there is no separate edges-index file.
  const outgoingBySource = collapseEdges(v1Edges, slugMap);
  const finalizedPages: ConceptPage[] = pages.map((page) => {
    const targets = outgoingBySource.get(page.slug);
    if (!targets || targets.size === 0) return page;
    return {
      ...page,
      frontmatter: {
        ...page.frontmatter,
        edges: [...targets].sort(),
      },
    };
  });

  // Page writes hit different filenames so they're safe to fan out.
  await Promise.all(
    finalizedPages.map((page) => writePage(workspaceDir, page)),
  );

  const promotions = derivePromotions(items);
  await appendPromotions(workspaceDir, promotions);

  const embedsEnqueued = enqueueEmbeds(finalizedPages.map((p) => p.slug));

  await writeSentinel(workspaceDir);

  let edgesWritten = 0;
  for (const targets of outgoingBySource.values()) {
    edgesWritten += targets.size;
  }

  return {
    pagesCreated: finalizedPages.length,
    edgesWritten,
    essentialsLines: promotions.essentials.length,
    threadsLines: promotions.threads.length,
    archiveLines: promotions.archive.length,
    embedsEnqueued,
    sentinelWritten: true,
  };
}

/**
 * Append each promotion bucket to its target file. Files are created if
 * absent — the workspace migration in PR 3 (`060-memory-v2-init`) seeds
 * empty placeholders, so this is mostly belt-and-suspenders.
 */
async function appendPromotions(
  workspaceDir: string,
  promotions: Promotions,
): Promise<void> {
  const memoryDir = join(workspaceDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(join(memoryDir, "archive"), { recursive: true });

  if (promotions.essentials.length > 0) {
    await appendLines(join(memoryDir, "essentials.md"), promotions.essentials);
  }
  if (promotions.threads.length > 0) {
    await appendLines(join(memoryDir, "threads.md"), promotions.threads);
  }
  if (promotions.archive.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    await appendLines(
      join(memoryDir, "archive", `migrated-${today}.md`),
      promotions.archive,
    );
  }
}

/** Append `lines` to `path`, creating it (with a trailing newline) if absent. */
async function appendLines(path: string, lines: string[]): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const trailing = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const next = `${existing}${trailing}${lines.join("\n")}\n`;
  await writeFile(path, next, "utf-8");
}

/** Write the migration sentinel. The body is metadata for human inspection. */
async function writeSentinel(workspaceDir: string): Promise<void> {
  const sentinelPath = join(workspaceDir, MIGRATION_SENTINEL_RELATIVE);
  await mkdir(join(workspaceDir, "memory", ".v2-state"), { recursive: true });
  await writeFile(sentinelPath, `${new Date().toISOString()}\n`, "utf-8");
}

/**
 * Memory v2 route definitions — backfill, validate, concept-page reads,
 * reembed-skills, and the activation-log concept-frequency aggregator.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { loadConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { getDb } from "../../memory/db-connection.js";
import {
  enqueueMemoryJob,
  type MemoryJobType,
} from "../../memory/jobs-store.js";
import {
  type ConceptFrequencyResponse,
  getConceptFrequencySummary,
} from "../../memory/memory-v2-concept-frequency.js";
import {
  getEdgeIndex,
  totalEdgeCount,
  validateEdgeTargets,
} from "../../memory/v2/edge-index.js";
import { computeInjectionScores } from "../../memory/v2/injection-events.js";
import { loadNowText } from "../../memory/v2/now-text.js";
import { getPageIndex } from "../../memory/v2/page-index.js";
import {
  getConceptsDir,
  listPages,
  readPage,
  renderPageContent,
} from "../../memory/v2/page-store.js";
import { type RouterSource, runRouter } from "../../memory/v2/router.js";
import { seedV2SkillEntries } from "../../memory/v2/skill-store.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import type { RouteHandlerArgs } from "./types.js";

const log = getLogger("memory-v2-routes");

/**
 * Wire-format error code emitted when v2 routes reject a request because
 * `memory.v2.enabled` is false. Exported so tests and the macOS client can
 * reference the same string without drift.
 */
export const MEMORY_V2_DISABLED_CODE = "MEMORY_V2_DISABLED";

/**
 * Reject the request when memory v2 is not active. Returning 409 (rather
 * than serving a partial response) keeps clients honest — the desktop
 * Memories panel reads this code to render an explicit "disabled in
 * config" empty state.
 */
function requireMemoryV2Enabled(): void {
  if (!loadConfig().memory.v2.enabled) {
    throw new RouteError(
      "Memory v2 is not enabled — set memory.v2.enabled to true to use this command.",
      MEMORY_V2_DISABLED_CODE,
      409,
    );
  }
}

// ── Backfill ────────────────────────────────────────────────────────────

const MemoryV2BackfillParams = z
  .object({
    op: z.enum(["migrate", "reembed", "activation-recompute"]),
    force: z.boolean().optional(),
  })
  .strict();

export type MemoryV2BackfillOp = z.infer<typeof MemoryV2BackfillParams>["op"];

export type MemoryV2BackfillResult = {
  jobId: string;
};

const OP_TO_JOB_TYPE: Record<MemoryV2BackfillOp, MemoryJobType> = {
  migrate: "memory_v2_migrate",
  reembed: "memory_v2_reembed",
  "activation-recompute": "memory_v2_activation_recompute",
};

async function handleBackfill({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2BackfillResult> {
  requireMemoryV2Enabled();
  const { op, force } = MemoryV2BackfillParams.parse(body);
  const payload: Record<string, unknown> =
    op === "migrate" && force === true ? { force: true } : {};
  const jobId = enqueueMemoryJob(OP_TO_JOB_TYPE[op], payload);
  return { jobId };
}

// ── Validate ────────────────────────────────────────────────────────────

const MemoryV2ValidateParams = z.object({}).strict();

type MissingEdgeEndpoint = { from: string; to: string };
type OversizedPage = { slug: string; chars: number };
type ParseFailure = { slug: string; error: string };

export type MemoryV2ValidateResult = {
  pageCount: number;
  edgeCount: number;
  missingEdgeEndpoints: MissingEdgeEndpoint[];
  oversizedPages: OversizedPage[];
  parseFailures: ParseFailure[];
};

async function handleValidate({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ValidateResult> {
  // Intentionally NOT gated on `memory.v2.enabled`. Validate is a read-only
  // diagnostic walk over the on-disk concept-page workspace and must be
  // runnable before flipping the flag — operators (and the
  // vellum-memory-v2-migration skill) use it as the final dry-run check
  // immediately before enabling v2.
  MemoryV2ValidateParams.parse(body);

  const workspaceDir = getWorkspaceDir();
  const maxPageChars = loadConfig().memory.v2.max_page_chars;

  const slugs = await listPages(workspaceDir);
  const knownSlugs = new Set<string>();
  const oversizedPages: OversizedPage[] = [];
  const parseFailures: ParseFailure[] = [];

  for (const slug of slugs) {
    try {
      const page = await readPage(workspaceDir, slug);
      if (!page) continue;
      knownSlugs.add(slug);
      const chars = page.body.length;
      if (chars > maxPageChars) {
        oversizedPages.push({ slug, chars });
      }
    } catch (err) {
      parseFailures.push({
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const edgeIndex = await getEdgeIndex(workspaceDir);
  const { missing } = validateEdgeTargets(edgeIndex, knownSlugs);

  return {
    pageCount: knownSlugs.size,
    edgeCount: totalEdgeCount(edgeIndex),
    missingEdgeEndpoints: missing,
    oversizedPages,
    parseFailures,
  };
}

// ── Get concept page ────────────────────────────────────────────────────

const MemoryV2GetConceptPageParams = z
  .object({
    slug: z.string().min(1),
  })
  .strict();

export type MemoryV2GetConceptPageResult = {
  slug: string;
  /** Frontmatter + body, as produced by `renderPageContent`. */
  rendered: string;
};

async function handleGetConceptPage({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2GetConceptPageResult> {
  requireMemoryV2Enabled();
  const { slug } = MemoryV2GetConceptPageParams.parse(body);
  const workspaceDir = getWorkspaceDir();
  let page;
  try {
    page = await readPage(workspaceDir, slug);
  } catch (err) {
    throw new RouteError(
      `Failed to read concept page '${slug}': ${err instanceof Error ? err.message : String(err)}`,
      "MEMORY_V2_PAGE_READ_FAILED",
      400,
    );
  }
  if (!page) {
    throw new RouteError(
      `Concept page '${slug}' not found on disk`,
      "MEMORY_V2_PAGE_NOT_FOUND",
      404,
    );
  }
  return { slug, rendered: renderPageContent(page) };
}

// ── List concept pages ──────────────────────────────────────────────────

const MemoryV2ListConceptPagesParams = z.object({}).strict();

export type MemoryV2ListConceptPagesResult = {
  pages: Array<{
    slug: string;
    bodyBytes: number;
    edgeCount: number;
    updatedAtMs: number;
  }>;
};

async function handleListConceptPages({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ListConceptPagesResult> {
  requireMemoryV2Enabled();
  MemoryV2ListConceptPagesParams.parse(body);

  const workspaceDir = getWorkspaceDir();
  const conceptsDir = getConceptsDir(workspaceDir);
  const slugs = await listPages(workspaceDir);

  const settled = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const page = await readPage(workspaceDir, slug);
        if (!page) return null;
        const stats = await stat(join(conceptsDir, `${slug}.md`));
        return {
          slug,
          bodyBytes: Buffer.byteLength(page.body, "utf8"),
          edgeCount: page.frontmatter.edges.length,
          updatedAtMs: Math.floor(stats.mtimeMs),
        };
      } catch (err) {
        // A single corrupt page (bad YAML, schema mismatch, etc.) shouldn't
        // poison the whole listing — the validate route is the place to
        // surface those; this one is read-only and best-effort.
        log.warn(
          `Skipping concept page '${slug}' in list-concept-pages: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  const pages = settled.filter(
    (p): p is MemoryV2ListConceptPagesResult["pages"][number] => p !== null,
  );

  return { pages };
}

// ── Reembed skills ──────────────────────────────────────────────────────

const MemoryV2ReembedSkillsParams = z.object({}).strict();

export type MemoryV2ReembedSkillsResult = {
  success: true;
};

async function handleReembedSkills({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ReembedSkillsResult> {
  requireMemoryV2Enabled();
  MemoryV2ReembedSkillsParams.parse(body);

  // Unlike the queued backfill jobs above, this is a CLI-driven sync
  // request: the operator wants the cache replaced before the next prompt
  // assembly, so we await the seed inline rather than enqueueing it. Pass
  // `throwOnError` so embedding/Qdrant failures surface to the CLI instead
  // of being swallowed by the default best-effort behavior.
  await seedV2SkillEntries({ throwOnError: true });

  return { success: true };
}

// ── Concept injection frequency (debug-only) ────────────────────────────

const MemoryV2ConceptFrequencyParams = z
  .object({
    conversationId: z.string().min(1).optional(),
    sinceMs: z.number().int().nonnegative().optional(),
  })
  .strict();

async function handleConceptFrequency({
  body = {},
}: RouteHandlerArgs): Promise<ConceptFrequencyResponse> {
  requireMemoryV2Enabled();
  const { conversationId, sinceMs } =
    MemoryV2ConceptFrequencyParams.parse(body);
  const workspaceDir = getWorkspaceDir();
  return getConceptFrequencySummary(workspaceDir, { conversationId, sinceMs });
}

// ── EMA scores ──────────────────────────────────────────────────────────

const MemoryV2EmaScoresParams = z.object({}).strict();

export interface MemoryV2EmaScoresEntry {
  slug: string;
  /** Time-decayed injection frequency; 0 when no events in the read window. */
  score: number;
  /** File mtime in epoch ms; 0 for synthetic entries (skills, CLI commands). */
  modifiedAt: number;
}

export interface MemoryV2EmaScoresResult {
  /** Every page index entry, sorted by score descending then slug ASCII. */
  entries: MemoryV2EmaScoresEntry[];
}

async function handleEmaScores({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2EmaScoresResult> {
  // Intentionally NOT gated on `memory.v2.enabled` — operators inspecting
  // EMA data before flipping tier-2 routing on is a legitimate dry-run
  // use case, mirroring `memory_v2_validate`.
  MemoryV2EmaScoresParams.parse(body);

  const pageIndex = await getPageIndex(getWorkspaceDir());
  const slugs = pageIndex.entries.map((e) => e.slug);
  const scores = computeInjectionScores(getDb(), slugs, Date.now());

  const entries: MemoryV2EmaScoresEntry[] = pageIndex.entries.map((entry) => ({
    slug: entry.slug,
    score: scores.get(entry.slug) ?? 0,
    modifiedAt: entry.modifiedAt,
  }));
  entries.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return { entries };
}

// ── Simulate router (dry-run playground) ────────────────────────────────

const SimulateRouterOverridesSchema = z
  .object({
    tier1_size: z.number().int().min(1).nullable().optional(),
    tier2_size: z.number().int().min(1).nullable().optional(),
    batch_size: z.number().int().min(1).nullable().optional(),
  })
  .strict();

const MemoryV2SimulateRouterParams = z
  .object({
    query: z.string().min(1, "query must be non-empty"),
    configOverrides: SimulateRouterOverridesSchema.optional(),
  })
  .strict();

export interface MemoryV2SimulateRouterEffectiveConfig {
  tier1_size: number | null;
  tier2_size: number | null;
  batch_size: number | null;
  max_page_ids: number;
}

export interface MemoryV2SimulateRouterResult {
  /** Slugs the router would select, in model-returned order. */
  selectedSlugs: string[];
  /** Per-slug provenance: `"tier1"`, `"tier2"`, or `"tier3:<bucket>"`. */
  sourceBySlug: Record<string, RouterSource>;
  /** EMA scores for the selected slugs (0 when the slug has no events). */
  scores: Record<string, number>;
  /** `null` on success; otherwise one of the router failure reasons. */
  failureReason: string | null;
  /** The router config that actually ran (live merged with overrides). */
  effectiveConfig: MemoryV2SimulateRouterEffectiveConfig;
  /** The overrides the caller submitted, for display. */
  overrides: {
    tier1_size?: number | null;
    tier2_size?: number | null;
    batch_size?: number | null;
  };
  /** Page index size the router was given (post-tier-carve, all batches). */
  totalCandidatePages: number;
}

/**
 * Build the config the router will see by overlaying override values on top
 * of the live workspace config. Only the three new tier knobs are exposed —
 * everything else (provider, prompts, weights) stays exactly as it would on
 * a real turn. `undefined` means "inherit live"; `null` is a valid override
 * value (meaning "disable this tier").
 */
function applySimulateOverrides(
  live: AssistantConfig,
  overrides: z.infer<typeof SimulateRouterOverridesSchema> | undefined,
): AssistantConfig {
  if (!overrides) return live;
  const liveRouter = live.memory.v2.router;
  const mergedRouter = {
    ...liveRouter,
    ...("tier1_size" in overrides && overrides.tier1_size !== undefined
      ? { tier1_size: overrides.tier1_size }
      : {}),
    ...("tier2_size" in overrides && overrides.tier2_size !== undefined
      ? { tier2_size: overrides.tier2_size }
      : {}),
    ...("batch_size" in overrides && overrides.batch_size !== undefined
      ? { batch_size: overrides.batch_size }
      : {}),
  };
  return {
    ...live,
    memory: {
      ...live.memory,
      v2: {
        ...live.memory.v2,
        router: mergedRouter,
      },
    },
  };
}

export async function handleSimulateRouter({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2SimulateRouterResult> {
  requireMemoryV2Enabled();
  const { query, configOverrides } = MemoryV2SimulateRouterParams.parse(body);

  const liveConfig = loadConfig();
  const mergedConfig = applySimulateOverrides(liveConfig, configOverrides);
  const effectiveRouter = mergedConfig.memory.v2.router;

  const workspaceDir = getWorkspaceDir();
  const nowText = await loadNowText(workspaceDir);

  const routerResult = await runRouter({
    workspaceDir,
    userMessage: query,
    assistantMessage: "",
    nowText,
    priorEverInjected: [],
    config: mergedConfig,
    database: getDb(),
  });

  const pageIndex = await getPageIndex(workspaceDir);
  const scores = computeInjectionScores(
    getDb(),
    routerResult.selectedSlugs,
    Date.now(),
  );

  const sourceBySlug: Record<string, RouterSource> = {};
  for (const [slug, source] of routerResult.sourceBySlug.entries()) {
    sourceBySlug[slug] = source;
  }

  const scoresOut: Record<string, number> = {};
  for (const slug of routerResult.selectedSlugs) {
    scoresOut[slug] = scores.get(slug) ?? 0;
  }

  return {
    selectedSlugs: routerResult.selectedSlugs,
    sourceBySlug,
    scores: scoresOut,
    failureReason: routerResult.failureReason,
    effectiveConfig: {
      tier1_size: effectiveRouter.tier1_size,
      tier2_size: effectiveRouter.tier2_size,
      batch_size: effectiveRouter.batch_size,
      max_page_ids: effectiveRouter.max_page_ids,
    },
    overrides: {
      ...(configOverrides?.tier1_size !== undefined
        ? { tier1_size: configOverrides.tier1_size }
        : {}),
      ...(configOverrides?.tier2_size !== undefined
        ? { tier2_size: configOverrides.tier2_size }
        : {}),
      ...(configOverrides?.batch_size !== undefined
        ? { batch_size: configOverrides.batch_size }
        : {}),
    },
    totalCandidatePages: pageIndex.entries.length,
  };
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v2_backfill",
    method: "POST",
    endpoint: "memory/v2/backfill",
    handler: handleBackfill,
    summary: "Enqueue a memory v2 backfill job",
    description:
      "Enqueues one of four operator-triggered backfill jobs (migrate, rebuild-edges, reembed, activation-recompute) against the memory jobs queue.",
    tags: ["memory"],
    requestBody: MemoryV2BackfillParams,
  },
  {
    operationId: "memory_v2_validate",
    method: "POST",
    endpoint: "memory/v2/validate",
    handler: handleValidate,
    summary: "Validate memory v2 workspace state",
    description:
      "Read-only structural validation of the v2 workspace — reports orphan edges, oversized pages, and parse failures. Runnable regardless of memory.v2.enabled so operators can dry-run validation before flipping the flag.",
    tags: ["memory"],
    requestBody: MemoryV2ValidateParams,
  },
  {
    operationId: "memory_v2_get_concept_page",
    method: "POST",
    endpoint: "memory/v2/concept-page",
    handler: handleGetConceptPage,
    summary: "Read a single memory v2 concept page",
    description:
      "Returns the rendered (frontmatter + body) markdown for a slug. 404 when the slug has no on-disk page — the activation log inspector uses this to show what got injected.",
    tags: ["memory"],
    requestBody: MemoryV2GetConceptPageParams,
  },
  {
    operationId: "memory_v2_list_concept_pages",
    method: "POST",
    endpoint: "memory/v2/list-concept-pages",
    handler: handleListConceptPages,
    summary: "List all memory v2 concept pages with metadata",
    description:
      "Returns slugs, body sizes, edge counts, and last-modified timestamps for every concept page on disk. Read-only; used by the desktop About → Memories surface to render a browse-able list.",
    tags: ["memory"],
    requestBody: MemoryV2ListConceptPagesParams,
  },
  {
    operationId: "memory_v2_reembed_skills",
    method: "POST",
    endpoint: "memory/v2/reembed-skills",
    handler: handleReembedSkills,
    summary: "Re-seed v2 skill entries from the current skill catalog",
    description:
      "Synchronously re-runs seedV2SkillEntries against the current skill catalog. Gated on config.memory.v2.enabled.",
    tags: ["memory"],
    requestBody: MemoryV2ReembedSkillsParams,
  },
  {
    operationId: "memory_v2_concept_frequency",
    method: "POST",
    endpoint: "memory/v2/concept-frequency",
    handler: handleConceptFrequency,
    summary: "Aggregate per-concept injection frequency from activation logs",
    description:
      "Debug-only. Aggregates the existing memory_v2_activation_logs table by (slug, status) and cross-references on-disk concept pages so an operator can see which concepts get injected often, which get scored but rejected, and which on-disk pages never even surface as candidates. Optional filters: conversationId narrows to a single conversation; sinceMs restricts to logs created at-or-after the given epoch ms timestamp.",
    tags: ["memory"],
    requestBody: MemoryV2ConceptFrequencyParams,
  },
  {
    operationId: "memory_v2_ema_scores",
    method: "POST",
    endpoint: "memory/v2/ema-scores",
    handler: handleEmaScores,
    summary: "List every concept page with its injection-frequency EMA score",
    description:
      "Computes the time-decayed injection frequency (3-day half-life) for every entry in the current page index by reading memory_v2_injection_events. Returns entries sorted by score descending then slug ASCII, including zero-score pages so callers can decide whether to filter. Read-only; tier 2 of the v4 router uses the same computation to pick its top-M.",
    tags: ["memory"],
    requestBody: MemoryV2EmaScoresParams,
  },
  {
    operationId: "memory_v2_simulate_router",
    method: "POST",
    endpoint: "memory/v2/simulate-router",
    handler: handleSimulateRouter,
    summary: "Dry-run the v4 router with config overrides (read-only)",
    description:
      "Runs the memory router against the live page index + EMA scores with optional tier_size / batch_size overrides, without recording an injection event or writing an activation log. Returns the slugs that would have been selected, per-slug tier provenance, EMA scores, and the effective router config so operators can validate knob changes before flipping them in workspace config.",
    tags: ["memory"],
    requestBody: MemoryV2SimulateRouterParams,
  },
];

/**
 * Memory v2 route definitions — backfill, validate, concept-page reads,
 * reembed-skills, and the activation-log concept-frequency aggregator.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { getEffectiveProfiles } from "../../../../config/default-profile-catalog.js";
import { loadConfig } from "../../../../config/loader.js";
import type { AssistantConfig } from "../../../../config/types.js";
import { getDb } from "../../../../persistence/db-connection.js";
import {
  enqueueMemoryJob,
  type MemoryJobType,
} from "../../../../persistence/jobs-store.js";
import { ACTOR_PRINCIPALS } from "../../../../runtime/auth/route-policy.js";
import { RouteError } from "../../../../runtime/routes/errors.js";
import type { RouteDefinition } from "../../../../runtime/routes/types.js";
import type { RouteHandlerArgs } from "../../../../runtime/routes/types.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { getLogger } from "../logging.js";
import {
  type ConceptFrequencyResponse,
  getConceptFrequencySummary,
} from "../memory-v2-concept-frequency.js";
import {
  getEdgeIndex,
  totalEdgeCount,
  validateEdgeTargets,
} from "../v2/edge-index.js";
import { runComparisonOverHistory } from "../v2/harness/compare.js";
import type { Retriever } from "../v2/harness/retriever.js";
import { createRouterRetriever } from "../v2/harness/router-retriever.js";
import type { ComparisonReport } from "../v2/harness/runner.js";
import { computeInjectionScores } from "../v2/injection-events.js";
import { loadNowText } from "../v2/now-text.js";
import { getPageIndex } from "../v2/page-index.js";
import {
  getConceptsDir,
  listPages,
  readPage,
  renderPageContent,
} from "../v2/page-store.js";
import { ROUTER_PROMPT } from "../v2/prompts/router.js";
import { type RouterSource, runRouter } from "../v2/router.js";
import { seedV2SkillEntries } from "../v2/skill-store.js";

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

export const MemoryV2ListConceptPagesResultSchema = z.object({
  pages: z.array(
    z.object({
      slug: z.string(),
      bodyBytes: z.number(),
      edgeCount: z.number(),
      updatedAtMs: z.number(),
    }),
  ),
});

export type MemoryV2ListConceptPagesResult = z.infer<
  typeof MemoryV2ListConceptPagesResultSchema
>;

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

const RecentTurnPairSchema = z
  .object({
    assistantMessage: z.string(),
    userMessage: z.string(),
  })
  .strict();

const MemoryV2SimulateRouterParams = z
  .object({
    /**
     * Recent (assistant, user) turn pairs to render inside `<last_turn>`,
     * oldest first. Required; must contain at least one entry. The last
     * entry's `userMessage` is the just-arrived turn the router is
     * routing for (must be non-empty); earlier entries are conversation
     * history. The oldest pair's `assistantMessage` may be empty for a
     * first-turn scenario — the daemon skips that `[assistant]:` line
     * the same way `runRouterBatch` does in prod.
     */
    recentTurnPairs: z
      .array(RecentTurnPairSchema)
      .min(1, "recentTurnPairs must contain at least one entry")
      .refine(
        (pairs) => pairs[pairs.length - 1].userMessage.length > 0,
        "the last recentTurnPairs entry's userMessage must be non-empty",
      ),
    /**
     * Verbatim `<now>` body. When omitted, the daemon loads the workspace's
     * live NOW.md so callers that don't care about per-call now context get
     * production-like behavior for free. Pass an explicit string (including
     * the empty string) to override.
     */
    nowText: z.string().optional(),
    configOverrides: SimulateRouterOverridesSchema.optional(),
    profileOverride: z.string().min(1).optional(),
    /**
     * Inline router system-prompt override (simulator only). Empty /
     * whitespace-only strings are normalized to "no override" so a
     * cleared textarea behaves the same as never opening it. The 1 MiB
     * cap mirrors the file-path size guard in `resolveRouterPrompt`.
     */
    routerPromptOverride: z.string().max(1_000_000).optional(),
  })
  .strict();

export const MemoryV2SimulateRouterResultSchema = z.object({
  /** Slugs the router would select, in model-returned order. */
  selectedSlugs: z.array(z.string()),
  /**
   * Per-slug provenance keyed by slug. Each value is `"tier1"`, `"tier2"`,
   * or `"tier3:<bucket>"` (see `RouterSource`); the wire shape is a plain
   * string map so callers parse the tier prefix at the boundary.
   */
  sourceBySlug: z.record(z.string(), z.string()),
  /** EMA scores for the selected slugs (0 when the slug has no events). */
  scores: z.record(z.string(), z.number()),
  /** `null` on success; otherwise one of the router failure reasons. */
  failureReason: z.string().nullable(),
  /** The router config that actually ran (live merged with overrides). */
  effectiveConfig: z.object({
    tier1_size: z.number().nullable(),
    tier2_size: z.number().nullable(),
    batch_size: z.number().nullable(),
    max_page_ids: z.number(),
  }),
  /** The overrides the caller submitted, for display. */
  overrides: z.object({
    tier1_size: z.number().nullish(),
    tier2_size: z.number().nullish(),
    batch_size: z.number().nullish(),
  }),
  /** Page index size the router was given (post-tier-carve, all batches). */
  totalCandidatePages: z.number(),
  /** The profile name passed as a per-call override, if any. */
  profileOverride: z.string().nullable(),
  /** `true` when an inline `routerPromptOverride` was applied this call. */
  routerPromptOverridden: z.boolean(),
});

export type MemoryV2SimulateRouterResult = z.infer<
  typeof MemoryV2SimulateRouterResultSchema
>;

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
  const {
    recentTurnPairs,
    nowText: rawNowText,
    configOverrides,
    profileOverride,
    routerPromptOverride: rawRouterPromptOverride,
  } = MemoryV2SimulateRouterParams.parse(body);

  // Normalize whitespace-only strings to "no override" so the
  // bundled/file prompt resolution behaves the same as a cleared editor.
  const routerPromptOverride =
    rawRouterPromptOverride !== undefined &&
    rawRouterPromptOverride.trim().length > 0
      ? rawRouterPromptOverride
      : undefined;

  const liveConfig = loadConfig();
  const mergedConfig = applySimulateOverrides(liveConfig, configOverrides);
  const effectiveRouter = mergedConfig.memory.v2.router;

  // Validate the requested profile name against the configured profile
  // catalog so the caller gets a structured 400 instead of a silent fall-
  // through (the resolver tolerates missing override-profile references by
  // design, but the playground wants the user to know they typo'd).
  if (profileOverride !== undefined) {
    const profiles = getEffectiveProfiles(liveConfig.llm?.profiles);
    if (!Object.prototype.hasOwnProperty.call(profiles, profileOverride)) {
      const available = Object.keys(profiles).sort();
      const hint =
        available.length > 0
          ? ` Available profiles: ${available.join(", ")}.`
          : " No profiles defined in llm.profiles.";
      throw new RouteError(
        `Profile "${profileOverride}" is not defined in llm.profiles.${hint}`,
        "MEMORY_V2_SIMULATE_INVALID_PROFILE",
        400,
      );
    }
  }

  const workspaceDir = getWorkspaceDir();
  // Caller can override `<now>` explicitly; otherwise fall back to the
  // live workspace NOW.md so a UI that doesn't supply nowText still
  // exercises a production-like context.
  const nowText =
    rawNowText !== undefined ? rawNowText : await loadNowText(workspaceDir);

  const routerResult = await runRouter({
    workspaceDir,
    recentTurnPairs,
    nowText,
    priorEverInjected: [],
    config: mergedConfig,
    database: getDb(),
    ...(profileOverride !== undefined
      ? { overrideProfile: profileOverride }
      : {}),
    ...(routerPromptOverride !== undefined ? { routerPromptOverride } : {}),
    // Always return the full union — the simulator's job is to surface
    // what the router actually picked across all batches, not what
    // injection.ts would have trimmed it to. The `max_page_ids` knob is
    // still echoed in `effectiveConfig` so the UI can show the live cap
    // as informational context.
    disableUnionCap: true,
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
    profileOverride: profileOverride ?? null,
    routerPromptOverridden: routerPromptOverride !== undefined,
  };
}

// ── Router prompt template (bundled default for the playground editor) ──

export const MemoryV2RouterPromptTemplateResultSchema = z.object({
  /** The bundled router prompt body, placeholders intact. */
  template: z.string(),
});

export type MemoryV2RouterPromptTemplateResult = z.infer<
  typeof MemoryV2RouterPromptTemplateResultSchema
>;

async function handleGetRouterPromptTemplate(): Promise<MemoryV2RouterPromptTemplateResult> {
  requireMemoryV2Enabled();
  return { template: ROUTER_PROMPT };
}

// ── Current `<now>` body (default value for the playground editor) ──────

export const MemoryV2NowTextResultSchema = z.object({
  /** The current rendered NOW.md body (autoloaded essentials/threads/recent). */
  nowText: z.string(),
});

export type MemoryV2NowTextResult = z.infer<typeof MemoryV2NowTextResultSchema>;

async function handleGetNowText(): Promise<MemoryV2NowTextResult> {
  requireMemoryV2Enabled();
  const workspaceDir = getWorkspaceDir();
  const nowText = await loadNowText(workspaceDir);
  return { nowText };
}

// ── Compare retrievers over historical turns (read-only) ────────────────

const MemoryV2CompareRetrieversParams = z
  .object({
    /**
     * How many historical `mode='router'` turns to sample. Each scored turn
     * re-runs the router (one LLM call), so keep this modest. Default 20.
     */
    limit: z.number().int().positive().optional(),
    strategy: z.enum(["recent", "random"]).optional(),
    conversationIds: z.array(z.string().min(1)).optional(),
    ks: z.array(z.number().int().positive()).optional(),
    includeNotInjected: z.boolean().optional(),
  })
  .strict();

const DEFAULT_COMPARE_LIMIT = 20;
const DEFAULT_COMPARE_KS = [5, 10, 25, 50];

export async function handleCompareRetrievers({
  body = {},
  abortSignal,
}: RouteHandlerArgs): Promise<ComparisonReport> {
  requireMemoryV2Enabled();
  const { limit, strategy, conversationIds, ks, includeNotInjected } =
    MemoryV2CompareRetrieversParams.parse(body);

  const config = loadConfig();
  const workspaceDir = getWorkspaceDir();
  const pageIndex = await getPageIndex(workspaceDir);
  const db = getDb();

  // The router is always comparand #1 (the harness self-test against its own
  // logged ground truth).
  const retrievers: Retriever[] = [createRouterRetriever(db)];

  return runComparisonOverHistory({
    db,
    workspaceDir,
    config,
    retrievers,
    ks: ks ?? DEFAULT_COMPARE_KS,
    limit: limit ?? DEFAULT_COMPARE_LIMIT,
    pageExists: (slug) => pageIndex.bySlug.has(slug),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(conversationIds !== undefined ? { conversationIds } : {}),
    ...(includeNotInjected !== undefined ? { includeNotInjected } : {}),
    ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
  });
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v2_backfill",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/list-concept-pages",
    handler: handleListConceptPages,
    summary: "List all memory v2 concept pages with metadata",
    description:
      "Returns slugs, body sizes, edge counts, and last-modified timestamps for every concept page on disk. Read-only; used by the desktop About → Memories surface to render a browse-able list.",
    tags: ["memory"],
    requestBody: MemoryV2ListConceptPagesParams,
    responseBody: MemoryV2ListConceptPagesResultSchema,
  },
  {
    operationId: "memory_v2_reembed_skills",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/simulate-router",
    handler: handleSimulateRouter,
    summary: "Dry-run the v4 router with config overrides (read-only)",
    description:
      "Runs the memory router against the live page index + EMA scores with optional tier_size / batch_size overrides, without recording an injection event or writing an activation log. Returns the slugs that would have been selected, per-slug tier provenance, EMA scores, and the effective router config so operators can validate knob changes before flipping them in workspace config.",
    tags: ["memory"],
    requestBody: MemoryV2SimulateRouterParams,
    responseBody: MemoryV2SimulateRouterResultSchema,
  },
  {
    operationId: "memory_v2_compare_retrievers",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/compare-retrievers",
    handler: handleCompareRetrievers,
    summary:
      "Compare retrievers against the router's logged selections (read-only)",
    description:
      "Runs one or more retrievers over a sample of historical turns (memory_v2_activation_logs, mode='router') and scores their selected pages against the logged selections as ground truth, reconstructing each turn's inputs from the messages table + current NOW. Read-only — writes nothing. Each scored turn re-runs the router (one LLM call), so keep `limit` modest. Today the only retriever is the router itself, so this is the harness self-test.",
    tags: ["memory"],
    requestBody: MemoryV2CompareRetrieversParams,
  },
  {
    operationId: "memory_v2_router_prompt_template",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/router-prompt-template",
    handler: handleGetRouterPromptTemplate,
    summary: "Return the bundled router system-prompt template",
    description:
      "Returns the bundled `ROUTER_PROMPT` body with placeholders intact (`{{ASSISTANT_NAME}}`, `{{USER_NAME}}`, `{{PAGE_INDEX}}`). Used by the memory router playground's 'Load default' affordance so users have a known-good starting point when authoring an inline prompt override.",
    tags: ["memory"],
    responseBody: MemoryV2RouterPromptTemplateResultSchema,
  },
  {
    operationId: "memory_v2_now_text",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/now-text",
    handler: handleGetNowText,
    summary: "Return the current rendered `<now>` body",
    description:
      "Returns the current NOW.md (autoloaded essentials/threads/recent). Used by the memory router playground to seed its `<now>` text area with a production-like default so callers can edit from a realistic baseline.",
    tags: ["memory"],
    responseBody: MemoryV2NowTextResultSchema,
  },
];

/**
 * Memory v2 route definitions — backfill, validate, concept-page reads,
 * reembed-skills, and the activation-log concept-frequency aggregator.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { loadConfig } from "../../config/loader.js";
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
import {
  getConceptsDir,
  listPages,
  readPage,
  renderPageContent,
} from "../../memory/v2/page-store.js";
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
  requireMemoryV2Enabled();
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
      "Read-only structural validation of the v2 workspace — reports orphan edges, oversized pages, and parse failures.",
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
];

/**
 * Memory v2 route definitions — backfill + validate + reembed-skills.
 *
 * Migrated from `ipc/routes/memory-v2-backfill.ts` and
 * `ipc/routes/memory-v2-validate.ts` into the shared ROUTES array.
 */
import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { loadConfig } from "../../config/loader.js";
import {
  enqueueMemoryJob,
  type MemoryJobType,
} from "../../memory/jobs-store.js";
import {
  getEdgeIndex,
  totalEdgeCount,
  validateEdgeTargets,
} from "../../memory/v2/edge-index.js";
import {
  listPages,
  readPage,
  renderPageContent,
} from "../../memory/v2/page-store.js";
import { seedV2SkillEntries } from "../../memory/v2/skill-store.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import type { RouteHandlerArgs } from "./types.js";

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
      const chars = Buffer.byteLength(page.body, "utf8");
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
  /** Frontmatter + body, exactly as `renderInjectionBlock` would format it. */
  rendered: string;
};

async function handleGetConceptPage({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2GetConceptPageResult> {
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

// ── Reembed skills ──────────────────────────────────────────────────────

const MemoryV2ReembedSkillsParams = z.object({}).strict();

export type MemoryV2ReembedSkillsResult = {
  success: true;
};

async function handleReembedSkills({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ReembedSkillsResult> {
  MemoryV2ReembedSkillsParams.parse(body);

  // Gate the route on both the feature flag and the per-workspace config
  // toggle so the v2 skill collection never gets re-seeded against a
  // workspace whose v2 subsystem is intentionally off.
  const config = loadConfig();
  if (
    !isAssistantFeatureFlagEnabled("memory-v2-enabled", config) ||
    !config.memory.v2.enabled
  ) {
    throw new RouteError(
      "Memory v2 is not enabled — flip both the memory-v2-enabled feature flag and memory.v2.enabled to use this command.",
      "MEMORY_V2_DISABLED",
      409,
    );
  }

  // Unlike the queued backfill jobs above, this is a CLI-driven sync
  // request: the operator wants the cache replaced before the next prompt
  // assembly, so we await the seed inline rather than enqueueing it.
  await seedV2SkillEntries();

  return { success: true };
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
    operationId: "memory_v2_reembed_skills",
    method: "POST",
    endpoint: "memory/v2/reembed-skills",
    handler: handleReembedSkills,
    summary: "Re-seed v2 skill entries from the current skill catalog",
    description:
      "Synchronously re-runs seedV2SkillEntries against the current skill catalog. Gated on memory-v2-enabled flag and config.memory.v2.enabled.",
    tags: ["memory"],
    requestBody: MemoryV2ReembedSkillsParams,
  },
];

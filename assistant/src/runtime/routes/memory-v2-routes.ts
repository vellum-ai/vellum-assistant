/**
 * Memory v2 route definitions — backfill + validate.
 *
 * Migrated from `ipc/routes/memory-v2-backfill.ts` and
 * `ipc/routes/memory-v2-validate.ts` into the shared ROUTES array.
 */
import { z } from "zod";

import { loadConfig } from "../../config/loader.js";
import {
  enqueueMemoryJob,
  type MemoryJobType,
} from "../../memory/jobs-store.js";
import { readEdges, validateEdges } from "../../memory/v2/edges.js";
import { listPages, readPage } from "../../memory/v2/page-store.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { RouteDefinition } from "./types.js";
import type { RouteHandlerArgs } from "./types.js";

// ── Backfill ────────────────────────────────────────────────────────────

const MemoryV2BackfillParams = z
  .object({
    op: z.enum(["migrate", "rebuild-edges", "reembed", "activation-recompute"]),
    force: z.boolean().optional(),
  })
  .strict();

export type MemoryV2BackfillOp = z.infer<typeof MemoryV2BackfillParams>["op"];

export type MemoryV2BackfillResult = {
  jobId: string;
};

const OP_TO_JOB_TYPE: Record<MemoryV2BackfillOp, MemoryJobType> = {
  migrate: "memory_v2_migrate",
  "rebuild-edges": "memory_v2_rebuild_edges",
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

  const edgesIdx = await readEdges(workspaceDir);
  const validation = validateEdges(edgesIdx, knownSlugs);

  const missing = new Set(validation.missing);
  const missingEdgeEndpoints: MissingEdgeEndpoint[] = [];
  for (const [from, to] of edgesIdx.edges) {
    if (missing.has(from) || missing.has(to)) {
      missingEdgeEndpoints.push({ from, to });
    }
  }

  return {
    pageCount: knownSlugs.size,
    edgeCount: edgesIdx.edges.length,
    missingEdgeEndpoints,
    oversizedPages,
    parseFailures,
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
      "Read-only structural validation of the v2 workspace — reports orphan edges, oversized pages, and parse failures.",
    tags: ["memory"],
    requestBody: MemoryV2ValidateParams,
  },
];

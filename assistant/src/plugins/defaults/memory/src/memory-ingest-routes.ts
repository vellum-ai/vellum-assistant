/**
 * Memory ingest route: deterministic batch concept-page ingestion.
 *
 * Accepts fully-formed concept pages (frontmatter + body markdown) and writes
 * them straight into `memory/concepts/` via the substrate's `ingestPages`,
 * bypassing the consolidation buffer. No LLM is involved: every page is
 * validated and reported individually, writes hold the consolidation lock,
 * and reindex follow-up jobs are enqueued after a batch that wrote pages.
 */

import { z } from "zod";

import { getConfig } from "../../../../config/loader.js";
import { usesConceptPageMemory } from "../../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../../config/types.js";
import {
  ACTOR_PRINCIPALS,
  type RoutePolicy,
} from "../../../../runtime/auth/route-policy.js";
import {
  BadRequestError,
  ConflictError,
} from "../../../../runtime/routes/errors.js";
// Baselined plugin-to-host coupling: the declared requestBody schema must be
// the single source of truth for wire validation, and parse-body.ts owns the
// schema-to-400 mapping. Duplicating it here would drift.
import { parseBody } from "../../../../runtime/routes/parse-body.js";
import type { RouteDefinition } from "../../../../runtime/routes/types.js";
import { getWorkspaceDir } from "../paths.js";
import {
  IngestLockedError,
  ingestPages,
  MAX_INGEST_PAGES_PER_CALL,
} from "../substrate/ingest.js";

// Re-exported so IPC clients (the `assistant memory ingest` CLI) can chunk
// their input to the same cap the route enforces, without reaching past this
// route module into the substrate.
export { MAX_INGEST_PAGES_PER_CALL };

const MemoryIngestParamsSchema = z.object({
  /** Pages to ingest; `content` is the full page markdown (frontmatter + body). */
  pages: z
    .array(
      z.object({
        slug: z.string(),
        content: z.string(),
      }),
    )
    .min(1)
    .max(MAX_INGEST_PAGES_PER_CALL),
  /** Validate and report without touching disk or the lock. */
  dryRun: z.boolean().optional(),
  /** Rewrite pages whose slug already exists on disk (default: skip them). */
  overwrite: z.boolean().optional(),
});
export type MemoryIngestParams = z.infer<typeof MemoryIngestParamsSchema>;

const MemoryIngestResultSchema = z.object({
  results: z.array(
    z.object({
      slug: z.string(),
      action: z.enum(["written", "skipped_exists", "invalid"]),
      warnings: z.array(z.string()),
      error: z.string().optional(),
    }),
  ),
  written: z.number(),
  skipped: z.number(),
  invalid: z.number(),
  dryRun: z.boolean(),
});
export type MemoryIngestResult = z.infer<typeof MemoryIngestResultSchema>;

/**
 * Validate and ingest a batch of concept pages. `config` is injectable for
 * tests; production resolves the live config.
 */
export async function handleMemoryIngest(
  body: unknown,
  config: AssistantConfig = getConfig(),
): Promise<MemoryIngestResult> {
  if (!usesConceptPageMemory(config.memory)) {
    throw new BadRequestError(
      "Concept-page memory is not active - enable memory.v3.live (or memory.v2.enabled) to ingest pages.",
    );
  }
  const params = parseBody(MemoryIngestParamsSchema, body ?? {});
  try {
    return await ingestPages(getWorkspaceDir(), params.pages, {
      dryRun: params.dryRun,
      overwrite: params.overwrite,
    });
  } catch (err) {
    if (err instanceof IngestLockedError) {
      throw new ConflictError(
        `Memory ingest rejected: consolidation lock held by ${err.holder}. Retry after the current writer finishes.`,
      );
    }
    // The schema's `.max(MAX_INGEST_PAGES_PER_CALL)` rejects oversized
    // batches in `parseBody` before `ingestPages` runs; anything else that
    // escapes `ingestPages` is an internal error for the adapter to surface.
    throw err;
  }
}

const WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_ingest",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/ingest",
    handler: ({ body }) => handleMemoryIngest(body),
    summary:
      "Batch-ingest fully-formed concept pages directly into memory/concepts/ (bypassing the consolidation buffer) and enqueue reindex jobs",
    tags: ["memory"],
    requestBody: MemoryIngestParamsSchema,
    responseBody: MemoryIngestResultSchema,
  },
];

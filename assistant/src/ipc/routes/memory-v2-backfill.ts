/**
 * Memory v2 — mutating backfill IPC route.
 *
 * Enqueues one of four operator-triggered backfill jobs against the memory
 * jobs queue, returning the new `jobId` so callers can track progress:
 *
 *   - `migrate`              — one-shot v1->v2 synthesis (PR 16). Accepts an
 *                              optional `force: true` to overwrite an existing
 *                              v2 state when the sentinel is already present.
 *   - `rebuild-edges`        — recompute every concept page's `edges:`
 *                              frontmatter from `memory/edges.json`.
 *   - `reembed`              — fan out an `embed_concept_page` job per page
 *                              slug, plus four reserved-slug jobs for the
 *                              meta files.
 *   - `activation-recompute` — refresh persisted activation state for every
 *                              conversation that has a stored row.
 *
 * The route is intentionally thin: it validates input, picks the matching
 * memory-job type, and enqueues. The job worker (`jobs-worker.ts`) dispatches
 * to the handlers in `memory/v2/backfill-jobs.ts` (PR 21). Splitting enqueue
 * from execution lets backfills run on the background worker rather than
 * blocking the IPC connection on a multi-minute migration.
 *
 * Unlike `memory_v2/validate`, this route is mutating — every successful call
 * adds a row to `memory_jobs`. It does not require the `memory-v2-enabled`
 * feature flag, mirroring the validate route: an operator may need to migrate
 * a workspace before flipping the flag.
 */
import { z } from "zod";

import {
  enqueueMemoryJob,
  type MemoryJobType,
} from "../../memory/jobs-store.js";
import type { IpcRoute } from "../assistant-server.js";

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

/**
 * Map a public operation name to the internal `MemoryJobType` so callers
 * (CLI, UI, tests) speak in stable verbs while the queue keeps its own
 * naming convention.
 */
const OP_TO_JOB_TYPE: Record<MemoryV2BackfillOp, MemoryJobType> = {
  migrate: "memory_v2_migrate",
  "rebuild-edges": "memory_v2_rebuild_edges",
  reembed: "memory_v2_reembed",
  "activation-recompute": "memory_v2_activation_recompute",
};

export const memoryV2BackfillRoute: IpcRoute = {
  method: "memory_v2/backfill",
  handler: async (params): Promise<MemoryV2BackfillResult> => {
    const { op, force } = MemoryV2BackfillParams.parse(params ?? {});

    // `force` only applies to `migrate` and only when explicitly true — the
    // migration handler already defaults missing/false to false, so omitting
    // the field keeps the queued JSON minimal.
    const payload: Record<string, unknown> =
      op === "migrate" && force === true ? { force: true } : {};

    const jobId = enqueueMemoryJob(OP_TO_JOB_TYPE[op], payload);
    return { jobId };
  },
};

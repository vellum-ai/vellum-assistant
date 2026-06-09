/**
 * Trajectory schema + materializer for the LongMemEval-V2 benchmark.
 *
 * The loader (`loadLongMemEvalV2`) stops at the question/haystack join —
 * it produces `BenchmarkItem`s whose `trajectoryIds` reference rows in
 * V2's `trajectories.jsonl`. The runner needs the *content* of those
 * rows to stage as workspace files before the ingest turn.
 *
 * This module owns:
 *
 *  - the canonical Zod schema for a trajectory row
 *    (`TrajectoryRecordSchema`), shared with `trajectory-reader.ts`
 *  - the in-workspace path conventions
 *    (`WORKSPACE_TRAJECTORY_DIR`, `WORKSPACE_MANIFEST_PATH`)
 *  - the synchronous slice / serialize step
 *    (`materializeWorkspaceFiles(item, reader)`), which calls into a
 *    `TrajectoryReader` for the per-id payloads
 *
 * The I/O strategy (eager Map vs. positional reads against an indexed
 * file) lives next door in `trajectory-reader.ts`. This module stays
 * dumb about how the bytes get off disk.
 *
 * File layout convention (per the PR-6 design call):
 *
 *     longmemeval/trajectories/<trajectory_id>.json
 *
 * One JSON file per trajectory; agents see the directory plus the
 * `manifest.json` index listing the ordered ids. The question text and
 * its ability type are deliberately withheld from the manifest so the
 * ingest turn stays question-blind — the agent must remember broadly
 * from the haystack rather than retrieving against a known target.
 * The ingest message points at the directory rather than embedding
 * trajectory content — the on-disk format preserves V2's structured
 * `states[]` records (which carry action+observation pairs from web /
 * enterprise environments and are *not* chat logs).
 */
import { z } from "zod";

import type { WorkspaceFileWrite } from "../../../src/lib/adapter";

import type { BenchmarkItem } from "./loader";
import type { TrajectoryReader } from "./trajectory-reader";

/**
 * Minimum shape we validate. V2 trajectories carry `id` + `domain` plus
 * an arbitrary structured payload (`states[]`, etc.). We don't pin the
 * full shape so a hotfix release that adds fields doesn't take the
 * harness down — `.passthrough()` preserves everything we serialize.
 */
export const TrajectoryRecordSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

export type TrajectoryRecord = z.infer<typeof TrajectoryRecordSchema>;

/** Path inside the agent's workspace where staged trajectories land. */
export const WORKSPACE_TRAJECTORY_DIR = "longmemeval/trajectories";

/** Path inside the agent's workspace where the per-item manifest lives. */
export const WORKSPACE_MANIFEST_PATH = "longmemeval/manifest.json";

export interface MaterializeOptions {
  /** Optional override for the in-workspace directory. */
  trajectoryDir?: string;
  /** Optional override for the in-workspace manifest path. */
  manifestPath?: string;
}

/**
 * Resolves a single `BenchmarkItem` into the `WorkspaceFileWrite[]` that
 * `runIngestAsk` will push into the agent's workspace. The order of
 * the trajectory files in the returned array matches the haystack
 * order recorded in `item.trajectoryIds`, and the manifest carries the
 * same order so the agent can stream the haystack deterministically.
 *
 * Throws if any trajectory id referenced by the item is missing from
 * the reader — V2's published data passes `validate_data.py` so this
 * is an upstream-corruption signal rather than something to recover
 * from. Missing ids are reported in bulk (cheap `reader.has` checks
 * up front) so the operator sees the full diff, not just the first
 * broken id.
 *
 * Reads are issued concurrently via `Promise.all`. The reader's
 * positional `pread` semantics mean concurrent reads against a shared
 * file handle don't race on a shared cursor.
 */
export async function materializeWorkspaceFiles(
  item: BenchmarkItem,
  reader: TrajectoryReader,
  opts: MaterializeOptions = {},
): Promise<WorkspaceFileWrite[]> {
  if (item.trajectoryIds.length === 0) {
    throw new Error(
      `BenchmarkItem ${item.questionId} has no trajectory ids; ` +
        "the loader should have rejected an empty haystack earlier.",
    );
  }
  const trajectoryDir = opts.trajectoryDir ?? WORKSPACE_TRAJECTORY_DIR;
  const manifestPath = opts.manifestPath ?? WORKSPACE_MANIFEST_PATH;

  // Bulk-check presence before issuing any reads so the failure mode
  // for missing ids is the same it used to be: surface every absent
  // id at once, not just the first.
  const missing = item.trajectoryIds.filter((id) => !reader.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Trajectory ids referenced by ${item.questionId} are missing from ` +
        `trajectories.jsonl: ${missing.slice(0, 10).join(", ")}` +
        (missing.length > 10 ? ` … (+${missing.length - 10} more)` : ""),
    );
  }

  const records = await Promise.all(
    item.trajectoryIds.map((id) => reader.get(id)),
  );

  const writes: WorkspaceFileWrite[] = records.map((record) => ({
    path: `${trajectoryDir}/${record.id}.json`,
    content: `${JSON.stringify(record, null, 2)}\n`,
  }));

  const manifest = {
    questionId: item.questionId,
    trajectoryDir,
    trajectoryIds: item.trajectoryIds,
    count: item.trajectoryIds.length,
  };
  writes.push({
    path: manifestPath,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  return writes;
}

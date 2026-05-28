/**
 * Trajectory loader + materializer for the LongMemEval-V2 benchmark.
 *
 * The loader (`loadLongMemEvalV2`) stops at the question/haystack join —
 * it produces `BenchmarkItem`s whose `trajectoryIds` reference rows in
 * V2's `trajectories.jsonl`. The runner needs the *content* of those
 * rows to stage as workspace files before the ingest turn.
 *
 * This module:
 *
 *  - parses `trajectories.jsonl` into a `TrajectoryRecord` map keyed by id
 *  - selects the slice referenced by a single `BenchmarkItem` (or any
 *    string[] of ids), preserving haystack order
 *  - serializes the slice into `WorkspaceFileWrite[]` records ready for
 *    `runIngestAsk` to push into the agent's workspace via the adapter's
 *    `writeWorkspaceFile` capability
 *
 * File layout convention (per the PR-6 design call):
 *
 *     longmemeval/trajectories/<trajectory_id>.json
 *
 * One JSON file per trajectory; agents see the directory plus the
 * `manifest.json` index listing the ordered ids and the question text.
 * The ingest message points at the directory rather than embedding
 * trajectory content — the on-disk format preserves V2's structured
 * `states[]` records (which carry action+observation pairs from web /
 * enterprise environments and are *not* chat logs).
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import type { WorkspaceFileWrite } from "../../../src/lib/adapter";

import type { BenchmarkItem } from "./loader";

/**
 * Minimum shape we validate. V2 trajectories carry `id` + `domain` plus
 * an arbitrary structured payload (`states[]`, etc.). We don't pin the
 * full shape so a hotfix release that adds fields doesn't take the
 * harness down — `.passthrough()` preserves everything we serialize.
 */
const TrajectoryRecordSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

export type TrajectoryRecord = z.infer<typeof TrajectoryRecordSchema>;

const TRAJECTORIES_FILENAME = "trajectories.jsonl";

/** Path inside the agent's workspace where staged trajectories land. */
export const WORKSPACE_TRAJECTORY_DIR = "longmemeval/trajectories";

/** Path inside the agent's workspace where the per-item manifest lives. */
export const WORKSPACE_MANIFEST_PATH = "longmemeval/manifest.json";

/**
 * Streams `trajectories.jsonl` from disk into an id-keyed map.
 *
 * Performance note: the V2 small-tier `trajectories.jsonl` is on the
 * order of ~1 GB. For Phase 1 (5 items) we can tolerate a full read
 * into memory; Phase 2's full 451-Q small-tier run wants an indexed
 * lookup (a sibling `trajectories.idx` or a streaming JSONL reader)
 * and will land in the cache PR (PR-7). For now the contract is
 * "load once, reuse across items in the same run."
 */
export async function loadTrajectories(
  dataRoot: string,
): Promise<Map<string, TrajectoryRecord>> {
  const path = join(resolve(dataRoot), TRAJECTORIES_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `LongMemEval-V2 trajectories.jsonl not found at ${path}. ` +
          "Run `bash data/download.sh` from the benchmark directory.",
      );
    }
    throw err;
  }

  const out = new Map<string, TrajectoryRecord>();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Failed to parse trajectories.jsonl at line ${i + 1}: ${(err as Error).message}`,
      );
    }
    const result = TrajectoryRecordSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      throw new Error(
        `trajectories.jsonl line ${i + 1} failed schema validation: ${issues}`,
      );
    }
    const record = result.data;
    if (out.has(record.id)) {
      throw new Error(
        `Duplicate trajectory id "${record.id}" at line ${i + 1} of trajectories.jsonl`,
      );
    }
    out.set(record.id, record);
  }
  return out;
}

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
 * the map — V2's published data passes `validate_data.py` so this is
 * an upstream-corruption signal rather than something to recover from.
 */
export function materializeWorkspaceFiles(
  item: BenchmarkItem,
  trajectories: Map<string, TrajectoryRecord>,
  opts: MaterializeOptions = {},
): WorkspaceFileWrite[] {
  if (item.trajectoryIds.length === 0) {
    throw new Error(
      `BenchmarkItem ${item.questionId} has no trajectory ids; ` +
        "the loader should have rejected an empty haystack earlier.",
    );
  }
  const trajectoryDir = opts.trajectoryDir ?? WORKSPACE_TRAJECTORY_DIR;
  const manifestPath = opts.manifestPath ?? WORKSPACE_MANIFEST_PATH;

  const writes: WorkspaceFileWrite[] = [];
  const missing: string[] = [];
  for (const trajectoryId of item.trajectoryIds) {
    const record = trajectories.get(trajectoryId);
    if (!record) {
      missing.push(trajectoryId);
      continue;
    }
    writes.push({
      path: `${trajectoryDir}/${trajectoryId}.json`,
      content: `${JSON.stringify(record, null, 2)}\n`,
    });
  }
  if (missing.length > 0) {
    throw new Error(
      `Trajectory ids referenced by ${item.questionId} are missing from ` +
        `trajectories.jsonl: ${missing.slice(0, 10).join(", ")}` +
        (missing.length > 10 ? ` … (+${missing.length - 10} more)` : ""),
    );
  }

  const manifest = {
    questionId: item.questionId,
    ability: item.ability,
    question: item.question,
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

/**
 * Pre-flight cleanup for stale docker containers left behind by prior
 * `evals run` invocations.
 *
 * # The problem
 *
 * The eval harness's local gateway profile binds host port 20100 (see
 * `cli/src/lib/environments/seeds.ts`, `portBlock(20000).gateway`).
 * When a `vellum hatch` subprocess crashes between `docker create` and
 * `docker start`, the container lands in `Created` state — still holding
 * its port reservation — but `docker ps` (without `-a`) doesn't show
 * it, and the next eval run fails with the classic:
 *
 *   docker: Error response from daemon: ... bind for 0.0.0.0:20100
 *   failed: port is already allocated.
 *
 * `assistant-config.ts`'s `findAvailablePort` probes a port by trying
 * to *listen* on it. A `Created` container's port reservation doesn't
 * register as a TCP listener, so the prober reports "free" and the
 * subsequent `docker run -p 20100:20100` collides with the dormant
 * reservation. The only reliable fix is to sweep stale containers
 * before the new run starts.
 *
 * # What counts as orphaned
 *
 * A container matching our naming convention (see `inferRunIdFromContainerName`)
 * is orphaned when:
 *
 *   - Its run directory doesn't exist on disk. The run was cleaned up
 *     by the user (or an earlier scavenger pass) but the container
 *     was left dangling.
 *   - Its `run.json` exists and reports a terminal status
 *     (`completed`, `failed`, `abandoned`, `unknown`). The runner
 *     finished but `agent.shutdown()` failed to remove the container.
 *   - Its `run.json` reports `status: "running"` but `lastHeartbeatAt`
 *     is older than `freshHeartbeatMs` (default 60s). The runner is
 *     dead but the scavenger hasn't flipped the status yet. We err
 *     on the safe side here: if heartbeat is missing entirely, treat
 *     it as stale.
 *
 * A container whose run is running AND has a fresh heartbeat is kept
 * untouched, so a parallel `evals run` against the same `.runs/`
 * directory can never have its containers stolen out from under it.
 *
 * # Docker not available
 *
 * If `docker ps -a` fails (binary missing, daemon not running,
 * permission denied) we silently skip cleanup. The next adapter call
 * will surface a real, descriptive error if docker is genuinely
 * required, but we don't want to block local dev that doesn't use
 * docker at all.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandRunner } from "./runtime/command-runner";
import { NodeCommandRunner } from "./runtime/command-runner";
import { RUNS_DIR, type RunMetadata } from "./metrics";

/**
 * Container-name suffixes our adapters use. Ordered longest-first so
 * `inferRunIdFromContainerName` strips `-assistant-egress-jail` before
 * trying `-assistant` (which would otherwise leave `-egress-jail`
 * behind as part of the runId and fail the trailing-timestamp check).
 */
export const EVAL_CONTAINER_SUFFIXES = [
  "-assistant-egress-jail",
  "-hermes-egress-jail",
  "-assistant",
  "-hermes",
] as const;

/**
 * Run id pattern matching the `runId(profileId, testId, timestamp)`
 * generator in `commands/run.ts`:
 *
 *   eval-<profileId>-<testId>-<14 digits>
 *
 * The profileId/testId can themselves contain hyphens (and digits),
 * so we anchor on the trailing `-\d{14}` to lock the timestamp slot
 * and let the rest be anything-but-empty.
 */
export const EVAL_RUN_ID_RE = /^eval-.+-\d{14}$/;

/**
 * Default heartbeat freshness window. Matches the scavenger's threshold
 * in `metrics.ts` so a heartbeat that's stale enough to be scavenged is
 * also stale enough for us to remove its container. Tunable for tests.
 */
const DEFAULT_FRESH_HEARTBEAT_MS = 60_000;

/**
 * Derive the runId a container belongs to from its name. Returns
 * `undefined` if the name doesn't match any of our adapter conventions
 * (so we never delete a third-party container that happens to live on
 * the same docker daemon).
 *
 * Exported for tests.
 */
export function inferRunIdFromContainerName(name: string): string | undefined {
  for (const suffix of EVAL_CONTAINER_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const candidate = name.slice(0, -suffix.length);
      if (EVAL_RUN_ID_RE.test(candidate)) return candidate;
      return undefined;
    }
  }
  return undefined;
}

export interface OrphanCleanupReport {
  removed: number;
  kept: number;
  /** Set when cleanup was skipped (e.g. docker not available). */
  skipReason?: string;
  /** Container names that were removed. Exposed for logging / tests. */
  removedNames: string[];
}

export interface CleanupOrphanedEvalContainersOptions {
  /** Command runner — injected for tests. Defaults to `NodeCommandRunner`. */
  runner?: CommandRunner;
  /** Heartbeat freshness window in ms. Defaults to 60s. */
  freshHeartbeatMs?: number;
  /** Clock for stale-heartbeat math. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Directory holding per-run subdirectories. Defaults to `RUNS_DIR`
   * (`.runs`). Injected for tests so they can point at a tmpdir.
   */
  runsDir?: string;
}

async function readRunMetadataFile(
  runsDir: string,
  runId: string,
): Promise<RunMetadata | undefined> {
  try {
    const raw = await readFile(join(runsDir, runId, "run.json"), "utf8");
    return JSON.parse(raw) as RunMetadata;
  } catch {
    return undefined;
  }
}

/**
 * Classify a container against its run metadata. Pulled out as a pure
 * function for test coverage — it carries the entire orphan-decision
 * tree and is the bit most likely to drift if the metadata schema
 * grows new statuses.
 *
 * Exported for tests.
 */
export function shouldRemoveOrphan(input: {
  metadata: RunMetadata | undefined;
  nowMs: number;
  freshHeartbeatMs: number;
}): boolean {
  const { metadata, nowMs, freshHeartbeatMs } = input;
  // No metadata on disk → the run was cleaned up but the container
  // wasn't. Always remove.
  if (!metadata) return true;
  // Terminal status → the runner finished but failed to remove the
  // container. Always remove.
  if (metadata.status !== "running") return true;
  // Status === running. Check heartbeat freshness — a missing
  // heartbeat means the run never got far enough to write one, so
  // it's safe to assume it's dead.
  if (!metadata.lastHeartbeatAt) return true;
  const heartbeatMs = new Date(metadata.lastHeartbeatAt).getTime();
  if (Number.isNaN(heartbeatMs)) return true;
  return nowMs - heartbeatMs > freshHeartbeatMs;
}

/**
 * Sweep `docker ps -a` for containers matching our naming convention and
 * remove the orphaned ones. See module docstring for the full decision
 * tree. Returns a structured report so the CLI caller can log a summary.
 */
export async function cleanupOrphanedEvalContainers(
  options: CleanupOrphanedEvalContainersOptions = {},
): Promise<OrphanCleanupReport> {
  const runner = options.runner ?? new NodeCommandRunner();
  const freshHeartbeatMs =
    options.freshHeartbeatMs ?? DEFAULT_FRESH_HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  const runsDir = options.runsDir ?? RUNS_DIR;

  let listing;
  try {
    listing = await runner.run("docker", [
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
    ]);
  } catch (err) {
    return {
      removed: 0,
      kept: 0,
      removedNames: [],
      skipReason: `docker not available: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (listing.exitCode !== 0) {
    return {
      removed: 0,
      kept: 0,
      removedNames: [],
      skipReason: `docker ps exited ${listing.exitCode}: ${listing.stderr.trim() || "(no stderr)"}`,
    };
  }

  const containerNames = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const nowMs = now();
  let removed = 0;
  let kept = 0;
  const removedNames: string[] = [];
  for (const name of containerNames) {
    const runId = inferRunIdFromContainerName(name);
    if (!runId) continue;
    const metadata = await readRunMetadataFile(runsDir, runId);
    const remove = shouldRemoveOrphan({
      metadata,
      nowMs,
      freshHeartbeatMs,
    });
    if (!remove) {
      kept += 1;
      continue;
    }
    // `docker rm -f` removes both stopped and running containers and
    // releases their port reservations. Best-effort: a removal failure
    // (already gone, permission denied) shouldn't stop us from
    // cleaning up the rest.
    const rm = await runner
      .run("docker", ["rm", "-f", name])
      .catch(() => undefined);
    if (rm && rm.exitCode === 0) {
      removed += 1;
      removedNames.push(name);
    }
  }

  return { removed, kept, removedNames };
}

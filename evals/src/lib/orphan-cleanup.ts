/**
 * Pre-flight cleanup for stale docker resources left behind by prior
 * `evals run` invocations.
 *
 * # The problem
 *
 * The eval harness's local gateway profile binds host port 20100 (see
 * `cli/src/lib/environments/seeds.ts`, `portBlock(20000).gateway`).
 * When a `vellum hatch` subprocess crashes between `docker create` and
 * `docker start`, the gateway container lands in `Created` state —
 * still holding its port reservation — but `docker ps` (without `-a`)
 * doesn't show it, and the next eval run fails with the classic:
 *
 *   docker: Error response from daemon: ... bind for 0.0.0.0:20100
 *   failed: port is already allocated.
 *
 * `assistant-config.ts`'s `findAvailablePort` probes a port by trying
 * to *listen* on it. A `Created` container's port reservation doesn't
 * register as a TCP listener, so the prober reports "free" and the
 * subsequent `docker run -p 20100:20100` collides with the dormant
 * reservation. The only reliable fix is to sweep stale resources
 * before the new run starts.
 *
 * # What `vellum hatch` provisions per run
 *
 * One `vellum hatch` call materializes a full StatefulSet-equivalent
 * (see `cli/src/lib/docker.ts:dockerResourceNames`):
 *
 *   Containers:
 *     <runId>-assistant
 *     <runId>-gateway              ← holds host port 20100
 *     <runId>-credential-executor
 *   Network:
 *     <runId>-net
 *   Volumes:
 *     <runId>-socket
 *     <runId>-assistant-ipc
 *     <runId>-gateway-ipc
 *     <runId>-workspace
 *     <runId>-ces-sec
 *     <runId>-gateway-sec
 *
 * Plus, when `applyDockerEgressJail` succeeds, a sidecar container:
 *     <runId>-assistant-egress-jail
 *
 * The Hermes adapter is simpler — one container per run:
 *     <runId>-hermes
 *     <runId>-hermes-egress-jail (when the jail attaches)
 *
 * PR #31918's first pass only swept `-assistant` / `-hermes` (+ jails).
 * That removed the assistant but left the gateway container still
 * holding port 20100, so the next hatch hit the same port-allocation
 * failure. The sweep below now removes every resource a runId could
 * own, including the network and volumes (since `docker network create`
 * and `docker volume create` both fail on duplicate names).
 *
 * # What counts as orphaned
 *
 * A run that owns matching docker containers is orphaned when:
 *
 *   - Its run directory doesn't exist on disk. The run was cleaned up
 *     by the user (or an earlier scavenger pass) but the docker
 *     resources were left dangling.
 *   - Its `run.json` exists and reports a terminal status
 *     (`completed`, `failed`, `abandoned`, `unknown`). The runner
 *     finished but `agent.shutdown()` failed to remove its resources.
 *   - Its `run.json` reports `status: "running"` but `lastHeartbeatAt`
 *     is older than `freshHeartbeatMs` (default 60s). The runner is
 *     dead but the scavenger hasn't flipped the status yet. We err
 *     on the safe side: if heartbeat is missing entirely, treat it
 *     as stale.
 *
 * A run whose status is `running` AND whose heartbeat is fresh is
 * kept untouched, so a parallel `evals run` against the same `.runs/`
 * directory can never have its resources stolen out from under it.
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
 *
 * Drift watch: this list must include every container `vellum hatch`
 * and the hermes adapter create. If `dockerResourceNames` grows a new
 * service (or a new egress-jail sidecar gets named), append it here.
 */
export const EVAL_CONTAINER_SUFFIXES = [
  "-assistant-egress-jail",
  "-hermes-egress-jail",
  "-credential-executor",
  "-assistant",
  "-gateway",
  "-hermes",
] as const;

/**
 * Volume-name suffixes `vellum hatch` provisions (one set per runId).
 * Kept in sync with `cli/src/lib/docker.ts:dockerResourceNames`.
 *
 * The runId-suffixed network (`<runId>-net`) is created/removed via
 * its own `docker network` subcommand so it's tracked separately
 * below in `removeOrphanedRunResources`.
 */
export const EVAL_VOLUME_SUFFIXES = [
  "-socket",
  "-assistant-ipc",
  "-gateway-ipc",
  "-workspace",
  "-ces-sec",
  "-gateway-sec",
] as const;

/**
 * Network-name suffix `vellum hatch` provisions (one per runId).
 * Single-entry tuple kept as a named constant so the drift-watch list
 * above stays exhaustive.
 */
export const EVAL_NETWORK_SUFFIX = "-net" as const;

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
 * also stale enough for us to remove its resources. Tunable for tests.
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
  /** Number of distinct eval runs whose docker resources were removed. */
  removedRuns: number;
  /** Number of distinct eval runs left alone (fresh heartbeat). */
  keptRuns: number;
  /** The runIds removed. Exposed for logging / tests. */
  removedRunIds: string[];
  /**
   * Per-resource counters for telemetry. A removed run typically tears
   * down 3–6 containers, 1 network, and 6 volumes — but a partially
   * provisioned run may have fewer of each.
   */
  removedContainers: number;
  removedNetworks: number;
  removedVolumes: number;
  /** Set when cleanup was skipped (e.g. docker not available). */
  skipReason?: string;
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
 * Classify a run against its metadata. Pulled out as a pure function
 * for test coverage — it carries the entire orphan-decision tree and
 * is the bit most likely to drift if the metadata schema grows new
 * statuses.
 *
 * Exported for tests.
 */
export function shouldRemoveOrphan(input: {
  metadata: RunMetadata | undefined;
  nowMs: number;
  freshHeartbeatMs: number;
}): boolean {
  const { metadata, nowMs, freshHeartbeatMs } = input;
  // No metadata on disk → the run was cleaned up but its resources
  // weren't. Always remove.
  if (!metadata) return true;
  // Terminal status → the runner finished but failed to remove its
  // resources. Always remove.
  if (metadata.status !== "running") return true;
  // Status === running. Check heartbeat freshness — a missing
  // heartbeat means the run never got far enough to write one, so
  // it's safe to assume it's dead.
  if (!metadata.lastHeartbeatAt) return true;
  const heartbeatMs = new Date(metadata.lastHeartbeatAt).getTime();
  if (Number.isNaN(heartbeatMs)) return true;
  return nowMs - heartbeatMs > freshHeartbeatMs;
}

interface RemovedResourceCounts {
  containers: number;
  networks: number;
  volumes: number;
}

/**
 * Tear down every docker resource a single runId could own. Each
 * `docker rm` / `docker network rm` / `docker volume rm` is
 * best-effort — a "no such container/network/volume" exit is normal
 * (the run may have only created a subset before crashing) and
 * counts as a no-op, not a failure.
 *
 * Exported for tests.
 */
export async function removeOrphanedRunResources(
  runner: CommandRunner,
  runId: string,
): Promise<RemovedResourceCounts> {
  const counts: RemovedResourceCounts = {
    containers: 0,
    networks: 0,
    volumes: 0,
  };
  for (const suffix of EVAL_CONTAINER_SUFFIXES) {
    const rm = await runner
      .run("docker", ["rm", "-f", `${runId}${suffix}`])
      .catch(() => undefined);
    if (rm && rm.exitCode === 0) counts.containers += 1;
  }
  const netRm = await runner
    .run("docker", ["network", "rm", `${runId}${EVAL_NETWORK_SUFFIX}`])
    .catch(() => undefined);
  if (netRm && netRm.exitCode === 0) counts.networks += 1;
  for (const suffix of EVAL_VOLUME_SUFFIXES) {
    const volRm = await runner
      .run("docker", ["volume", "rm", `${runId}${suffix}`])
      .catch(() => undefined);
    if (volRm && volRm.exitCode === 0) counts.volumes += 1;
  }
  return counts;
}

/**
 * Sweep `docker ps -a` for containers matching our naming convention
 * and remove the orphaned ones' full resource set. See module docstring
 * for the full decision tree. Returns a structured report so the CLI
 * caller can log a summary.
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
      removedRuns: 0,
      keptRuns: 0,
      removedRunIds: [],
      removedContainers: 0,
      removedNetworks: 0,
      removedVolumes: 0,
      skipReason: `docker not available: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (listing.exitCode !== 0) {
    return {
      removedRuns: 0,
      keptRuns: 0,
      removedRunIds: [],
      removedContainers: 0,
      removedNetworks: 0,
      removedVolumes: 0,
      skipReason: `docker ps exited ${listing.exitCode}: ${listing.stderr.trim() || "(no stderr)"}`,
    };
  }

  const containerNames = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Dedupe to a unique set of runIds. Each run typically owns 3–4
  // containers, so iterating per-container would call `readRunMetadata`
  // and `shouldRemoveOrphan` redundantly.
  const candidateRunIds = new Set<string>();
  for (const name of containerNames) {
    const runId = inferRunIdFromContainerName(name);
    if (runId) candidateRunIds.add(runId);
  }

  const nowMs = now();
  const removedRunIds: string[] = [];
  let keptRuns = 0;
  let removedContainers = 0;
  let removedNetworks = 0;
  let removedVolumes = 0;
  for (const runId of candidateRunIds) {
    const metadata = await readRunMetadataFile(runsDir, runId);
    const remove = shouldRemoveOrphan({
      metadata,
      nowMs,
      freshHeartbeatMs,
    });
    if (!remove) {
      keptRuns += 1;
      continue;
    }
    const counts = await removeOrphanedRunResources(runner, runId);
    // We always count the runId as "removed" when we attempted cleanup
    // for it. A run with zero successfully-removed resources is still
    // worth reporting because the attempt itself is meaningful
    // (next-run idempotency). The per-resource counts give the
    // operator visibility into how much was actually torn down.
    removedRunIds.push(runId);
    removedContainers += counts.containers;
    removedNetworks += counts.networks;
    removedVolumes += counts.volumes;
  }

  return {
    removedRuns: removedRunIds.length,
    keptRuns,
    removedRunIds,
    removedContainers,
    removedNetworks,
    removedVolumes,
  };
}

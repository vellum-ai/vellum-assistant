/**
 * Force-removes docker containers belonging to abandoned `evals run`
 * invocations.
 *
 * # Why this exists
 *
 * Every Vellum-species eval hatches three docker containers (assistant,
 * gateway, credential-executor) named `<runId>-<service>`. The assistant
 * container always binds the daemon's fixed host port (7821, declared in
 * `cli/src/lib/environments/paths.ts`) directly — `hatchDocker` only
 * dynamically allocates the *gateway* port via `findOpenPort`, not the
 * assistant port. So a previous run that crashed (SIGKILL, OOM, host
 * reboot losing the process tree, …) without reaching `agent.shutdown`
 * leaves its assistant container alive and bound to 7821, which then
 * fails every subsequent hatch with:
 *
 *   driver failed programming external connectivity on endpoint
 *   <…>-assistant: Bind for 0.0.0.0:7821 failed: port is already allocated
 *
 * `commands/run.ts` already runs `scavengeAbandonedRuns` at startup to
 * flip the on-disk metadata from `running` → `abandoned` when a run's
 * heartbeat goes stale. The metadata flip alone doesn't free the
 * docker resources — without container-level reaping the next hatch
 * still collides. This module is the container-level companion to the
 * scavenger: same trigger (stale or terminal run), opposite side of
 * the resource pair (containers instead of run.json).
 *
 * # Scope
 *
 * - Only touches containers whose name starts with `eval-`. The full
 *   prefix is what `runId` looks like for every benchmark in the
 *   harness today (`eval-<benchmark>-<profile>-<test>-<ts>-<rand>` and
 *   `eval-<profile>-<test>-<ts>-<rand>` for personal-intelligence).
 *   Unrelated containers on the host are never inspected, never
 *   touched.
 *
 * - Preserves containers belonging to a `status: "running"` run whose
 *   last heartbeat is within the same 60s threshold the async
 *   scavenger uses. A concurrent `evals run` against the same `.runs`
 *   directory remains safe.
 *
 * - Reaps containers when their run.json is in any terminal state
 *   (`completed` / `failed` / `abandoned`), when the run.json is
 *   missing (run dir was deleted), or when the run.json is `running`
 *   but its heartbeat is older than the threshold (definitively dead).
 *
 * Best-effort: a docker CLI failure (missing binary, daemon down,
 * permissions, race with `docker container prune`) never throws.
 * The caller logs the structured result and proceeds — a leaked
 * container is a noisy failure ("port already allocated"), not a
 * silent corruption.
 */

import { readRunMetadata } from "../metrics";
import {
  NodeCommandRunner,
  type CommandRunner,
} from "../runtime/command-runner";

/** Default heartbeat staleness threshold (matches `DEFAULT_HEARTBEAT_TIMEOUT_MS`). */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

/**
 * The three Vellum hatch siblings. A container's runId is its name with
 * `-<service>` stripped; we recognize a container as ours when its name
 * ends in one of these suffixes.
 */
const VELLUM_HATCH_SERVICES = [
  "assistant",
  "gateway",
  "credential-executor",
] as const;
type HatchService = (typeof VELLUM_HATCH_SERVICES)[number];

const SERVICE_SUFFIX_PATTERN = new RegExp(
  `-(${VELLUM_HATCH_SERVICES.join("|")})$`,
);

/** Every container name we touch must start with this. */
const EVAL_CONTAINER_PREFIX = "eval-";

export interface ReapOptions {
  /** Injected for tests. Defaults to a fresh `NodeCommandRunner`. */
  runner?: CommandRunner;
  /**
   * Heartbeat staleness threshold (ms). A `status: "running"` run whose
   * `lastHeartbeatAt` (falling back to `startedAt`) is older than this
   * is considered dead and its containers reaped. Defaults to 60s —
   * same value the async scavenger uses.
   */
  heartbeatTimeoutMs?: number;
  /** Injected for tests so the heartbeat clock is deterministic. */
  now?: () => Date;
}

export interface ReapResult {
  /** Container names removed via `docker rm -f`. */
  reaped: string[];
  /** Container names left in place because their run is still live. */
  preserved: string[];
  /**
   * Container names that matched the `eval-` prefix but whose name
   * didn't parse to a `<runId>-<service>` tuple. Left in place so an
   * unrelated tool's container with an `eval-` prefix never gets
   * surprise-reaped. Surfaced separately so a future regression in the
   * container-name convention is visibly diagnosable.
   */
  unparseable: string[];
}

/**
 * Sweep all `eval-*` docker containers on the host and force-remove
 * the ones whose owning run is no longer live.
 */
export async function reapAbandonedEvalContainers(
  options: ReapOptions = {},
): Promise<ReapResult> {
  const runner = options.runner ?? new NodeCommandRunner();
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = options.now ? options.now() : new Date();

  const containerNames = await listEvalContainers(runner);

  const reaped: string[] = [];
  const preserved: string[] = [];
  const unparseable: string[] = [];

  for (const containerName of containerNames) {
    const parsed = parseContainerName(containerName);
    if (!parsed) {
      unparseable.push(containerName);
      continue;
    }
    const { runId } = parsed;
    const metadata = await readRunMetadata(runId).catch(() => undefined);
    if (isLive(metadata, now, heartbeatTimeoutMs)) {
      preserved.push(containerName);
      continue;
    }
    const removed = await removeContainer(runner, containerName);
    if (removed) reaped.push(containerName);
    // A failed remove (container vanished between list and rm, daemon
    // hiccup) is logged via the swallowed promise but not surfaced —
    // the next sweep will retry. Goal is to free fixed-port allocations
    // for the new run, not to provide auditable per-container outcomes.
  }

  return { reaped, preserved, unparseable };
}

/**
 * `docker ps -a` listing scoped to our naming convention. `-a` includes
 * stopped containers — a hatch that died mid-startup can leave a
 * `Created`-state container that still holds the port binding, so the
 * sweep has to cover non-running states too.
 */
async function listEvalContainers(runner: CommandRunner): Promise<string[]> {
  const result = await runner
    .run("docker", [
      "ps",
      "-a",
      "--filter",
      `name=^${EVAL_CONTAINER_PREFIX}`,
      "--format",
      "{{.Names}}",
    ])
    .catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter((name) => name.length > 0);
}

interface ParsedContainerName {
  runId: string;
  service: HatchService;
}

/**
 * Names follow `<runId>-<service>` where service ∈ {assistant, gateway,
 * credential-executor}. The runId itself always starts with `eval-` and
 * has the timestamp+random suffix appended by `runId()` /
 * `timestampSuffix()`; the regex never needs to peek inside the runId.
 */
function parseContainerName(name: string): ParsedContainerName | undefined {
  if (!name.startsWith(EVAL_CONTAINER_PREFIX)) return undefined;
  const match = name.match(SERVICE_SUFFIX_PATTERN);
  if (!match) return undefined;
  const service = match[1] as HatchService;
  const runId = name.slice(0, -1 * (service.length + 1));
  if (runId.length === 0) return undefined;
  return { runId, service };
}

/**
 * True when the run owning the container is still legitimately alive
 * and we should leave its containers in place. False when the run is
 * gone (no metadata on disk), terminal, or `running` with a stale
 * heartbeat (process-died-without-cleanup signature).
 */
function isLive(
  metadata: Awaited<ReturnType<typeof readRunMetadata>>,
  now: Date,
  heartbeatTimeoutMs: number,
): boolean {
  if (!metadata) return false;
  if (metadata.status !== "running") return false;
  const lastHeartbeat = metadata.lastHeartbeatAt
    ? new Date(metadata.lastHeartbeatAt)
    : metadata.startedAt
      ? new Date(metadata.startedAt)
      : undefined;
  if (!lastHeartbeat) return false;
  const ageMs = now.getTime() - lastHeartbeat.getTime();
  return ageMs <= heartbeatTimeoutMs;
}

async function removeContainer(
  runner: CommandRunner,
  containerName: string,
): Promise<boolean> {
  const result = await runner
    .run("docker", ["rm", "-f", containerName])
    .catch(() => undefined);
  return Boolean(result && result.exitCode === 0);
}

/**
 * Force-remove every Vellum hatch sibling container belonging to a
 * single runId. Used by the adapter's catch/shutdown paths as a
 * fallback after `vellum retire` runs — if retire returned non-zero
 * (failed assistant-config lookup, daemon stale, etc.) OR if retire
 * appeared to succeed but a container still binds the daemon's host
 * port, we force-reap the sibling containers directly via docker.
 *
 * Distinct from `reapAbandonedEvalContainers` (which sweeps the
 * entire `eval-*` namespace based on metadata-derived liveness):
 * this helper targets one specific runId and trusts the caller's
 * "this run is done" claim. No metadata check, no preserve list —
 * the caller already owns the run and is winding it down.
 *
 * Best-effort: per-container `docker rm -f` failures are swallowed
 * (the container may have legitimately already been gone). The
 * boolean return surfaces whether any container was actually removed,
 * which the adapter uses to decide whether to log a "force-reaped
 * surviving container(s)" warning.
 */
export async function reapContainersForRun(
  runner: CommandRunner,
  runId: string,
): Promise<{ reaped: string[] }> {
  if (!runId.startsWith(EVAL_CONTAINER_PREFIX)) {
    // Refuse to operate on non-eval runIds — same safety boundary as
    // the bulk reaper. A future caller passing a malformed id should
    // get a no-op, not a host-wide `docker rm` spree.
    return { reaped: [] };
  }
  const reaped: string[] = [];
  for (const service of VELLUM_HATCH_SERVICES) {
    const containerName = `${runId}-${service}`;
    if (await removeContainer(runner, containerName)) {
      reaped.push(containerName);
    }
  }
  return { reaped };
}

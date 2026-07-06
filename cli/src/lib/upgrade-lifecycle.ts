import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { AssistantEntry } from "./assistant-config.js";
import { saveAssistantEntry } from "./assistant-config.js";
import { createBackup, pruneOldBackups, restoreBackup } from "./backup-ops.js";
import { emitCliError } from "./cli-error.js";
import { getOrCreateHostDeviceId } from "./device-id.js";
import {
  captureImageRefs,
  DOCKER_READY_TIMEOUT_MS,
  dockerResourceNames,
  GATEWAY_INTERNAL_PORT,
  ASSISTANT_INTERNAL_PORT,
  startContainers,
  stopContainers,
} from "./docker.js";
import { getStateDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { loadGuardianToken } from "./guardian-token.js";
import { classifyReadyzResponse } from "./http-client.js";
import { fetchReleases, resolveImageRefs } from "./platform-releases.js";
import {
  getBuilderManagedEnvKeys,
  type DockerStatefulSetSpec,
  type ServiceName,
} from "./statefulset.js";
import { exec, execOutput } from "./step-runner.js";
import { compareVersions, stripVersionPrefix } from "./version-compat.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";

// ---------------------------------------------------------------------------
// Failure log capture
// ---------------------------------------------------------------------------

/** XDG-compliant directory for upgrade failure logs, scoped to the current environment. */
function getUpgradeLogsDir(): string {
  return join(getStateDir(getCurrentEnvironment()), "upgrade-logs");
}

/**
 * Capture stdout/stderr from all three containers after a readiness failure
 * and write them to an XDG state directory. Returns the directory path so
 * the caller can print it for the user.
 *
 * Runs best-effort — never throws.
 */
export async function captureUpgradeFailureLogs(
  res: ReturnType<typeof dockerResourceNames>,
  label: string,
): Promise<string | null> {
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = join(getUpgradeLogsDir(), `${label}-${isoTimestamp}`);
  try {
    mkdirSync(logDir, { recursive: true });

    const containers: [string, string][] = [
      [res.assistantContainer, "assistant.log"],
      [res.gatewayContainer, "gateway.log"],
      [res.cesContainer, "credential-executor.log"],
    ];

    for (const [container, filename] of containers) {
      try {
        // Capture stdout + stderr together so container logs written to either
        // stream (docker logs writes container stdout→stdout, stderr→stderr)
        // are preserved in a single file. spawnSync avoids the execOutput
        // limitation of returning only stdout on success.
        const result = spawnSync(
          "docker",
          ["logs", "--tail", "500", container],
          {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024, // 10 MB
          },
        );
        const output = [result.stdout, result.stderr].filter(Boolean).join("");
        if (output) writeFileSync(join(logDir, filename), output);
      } catch {
        // Container may not exist or may have already been removed
      }
    }

    return existsSync(logDir) ? logDir : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared constants & builders for upgrade / rollback lifecycle events
// ---------------------------------------------------------------------------

/** User-facing progress messages shared across upgrade and rollback flows. */
export const UPGRADE_PROGRESS = {
  DOWNLOADING: "Downloading…",
  BACKING_UP: "Saving a backup of your data…",
  INSTALLING: "Installing…",
  REVERTING: "Something went wrong. Reverting to the previous version…",
  REVERTING_MIGRATIONS: "Reverting database changes…",
  RESTORING: "Restoring your data…",
  SWITCHING: "Switching to the previous version…",
} as const;

export function buildStartingEvent(
  targetVersion: string,
  expectedDowntimeSeconds = 60,
) {
  return { type: "starting" as const, targetVersion, expectedDowntimeSeconds };
}

export function buildProgressEvent(statusMessage: string) {
  return { type: "progress" as const, statusMessage };
}

export function buildCompleteEvent(
  installedVersion: string,
  success: boolean,
  rolledBackToVersion?: string,
) {
  return {
    type: "complete" as const,
    installedVersion,
    success,
    ...(rolledBackToVersion ? { rolledBackToVersion } : {}),
  };
}

export function buildUpgradeCommitMessage(options: {
  action: "upgrade" | "rollback";
  phase: "starting" | "complete";
  from: string;
  to: string;
  topology: "docker" | "local" | "managed";
  assistantId: string;
  result?: "success" | "failure";
}): string {
  const { action, phase, from, to, topology, assistantId, result } = options;
  const header =
    phase === "starting"
      ? `[${action}] Starting: ${from} → ${to}`
      : `[${action}] Complete: ${from} → ${to}`;
  const lines = [
    header,
    "",
    `assistant: ${assistantId}`,
    `from: ${from}`,
    `to: ${to}`,
  ];
  if (result) lines.push(`result: ${result}`);
  lines.push(`topology: ${topology}`);
  return lines.join("\n");
}

/**
 * Capture environment variables from a running Docker container so they
 * can be replayed onto the replacement container after upgrade.
 */
export async function captureContainerEnv(
  containerName: string,
): Promise<Record<string, string>> {
  const captured: Record<string, string> = {};
  try {
    const raw = await execOutput("docker", [
      "inspect",
      "--format",
      "{{json .Config.Env}}",
      containerName,
    ]);
    const entries = JSON.parse(raw) as string[];
    for (const entry of entries) {
      const eqIdx = entry.indexOf("=");
      if (eqIdx > 0) {
        captured[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
      }
    }
  } catch {
    // Container may not exist or not be inspectable
  }
  return captured;
}

/**
 * Filter a captured container env down to the entries safe to replay onto a
 * replacement container.
 *
 * Drops every key `buildServiceRunArgs` sets itself (spec static/secret
 * entries, builder-computed extras, PATH). Spec-managed secrets re-enter via
 * the dedicated `DockerRunSecrets` path, so adding a secret to the spec
 * automatically excludes it here. Spec host-forwarded keys are dropped only
 * when the host variable is currently set, so fresh host values win over
 * stale captured ones.
 *
 * Security contract: the returned env is memory-only — never persist it to
 * disk, and log counts only, never values.
 */
export function buildReplayEnv(
  capturedEnv: Record<string, string>,
  service: ServiceName,
  spec?: DockerStatefulSetSpec,
): Record<string, string> {
  const { always, hostForwarded } = getBuilderManagedEnvKeys(service, spec);
  const hostManaged = new Set(
    hostForwarded.filter((h) => process.env[h.hostVar]).map((h) => h.name),
  );
  return Object.fromEntries(
    Object.entries(capturedEnv).filter(
      ([key]) => !always.has(key) && !hostManaged.has(key),
    ),
  );
}

/** Secrets and replay env derived from the outgoing containers. */
interface ReplayState {
  bootstrapSecret: string | undefined;
  cesServiceToken: string;
  signingKey: string;
  extraAssistantEnv: Record<string, string>;
  extraGatewayEnv: Record<string, string>;
}

/**
 * Derive the secrets and replay env for replacement containers from
 * already-captured assistant/gateway envs. GUARDIAN_BOOTSTRAP_SECRET is only
 * set on the gateway; CES_SERVICE_TOKEN and ACTOR_TOKEN_SIGNING_KEY fall back
 * to fresh values for instances that predate them. VELLUM_DEVICE_ID is
 * backfilled on the gateway from the host, and the assistant inherits the
 * gateway's value (captured values win) so the pair always matches.
 */
export function buildReplayState(
  capturedEnv: Record<string, string>,
  gatewayEnv: Record<string, string>,
): ReplayState {
  const extraGatewayEnv = buildReplayEnv(gatewayEnv, "gateway");
  extraGatewayEnv.VELLUM_DEVICE_ID ??= getOrCreateHostDeviceId();

  const extraAssistantEnv = buildReplayEnv(capturedEnv, "assistant");
  extraAssistantEnv.VELLUM_DEVICE_ID ??= extraGatewayEnv.VELLUM_DEVICE_ID;

  return {
    bootstrapSecret: gatewayEnv["GUARDIAN_BOOTSTRAP_SECRET"],
    cesServiceToken:
      capturedEnv["CES_SERVICE_TOKEN"] || randomBytes(32).toString("hex"),
    signingKey:
      capturedEnv["ACTOR_TOKEN_SIGNING_KEY"] || randomBytes(32).toString("hex"),
    extraAssistantEnv,
    extraGatewayEnv,
  };
}

/**
 * Capture the assistant and gateway container envs and derive the replay
 * state for the replacement containers. Logs only the assistant env-var
 * count (security contract on `buildReplayEnv`).
 */
export async function captureReplayState(
  res: Pick<
    ReturnType<typeof dockerResourceNames>,
    "assistantContainer" | "gatewayContainer"
  >,
): Promise<ReplayState> {
  console.log("💾 Capturing existing container environment...");
  const [capturedEnv, gatewayEnv] = await Promise.all([
    captureContainerEnv(res.assistantContainer),
    captureContainerEnv(res.gatewayContainer),
  ]);
  console.log(
    `   Captured ${Object.keys(capturedEnv).length} env var(s) from ${res.assistantContainer}\n`,
  );
  return buildReplayState(capturedEnv, gatewayEnv);
}

/**
 * Best-effort fetch of the running service group version from the gateway
 * `/healthz` endpoint.  Returns `undefined` when the endpoint is
 * unreachable or does not include a version field.
 */
export async function fetchCurrentVersion(
  runtimeUrl: string,
): Promise<string | undefined> {
  try {
    const resp = await loopbackSafeFetch(`${runtimeUrl}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const body = (await resp.json()) as { version?: string };
      return body.version;
    }
  } catch {
    // Best-effort
  }
  return undefined;
}

/**
 * Best-effort fetch of the assistant's configured public ingress URL from the
 * gateway `integrations/ingress/config` endpoint.  Returns `undefined` when
 * the gateway is unreachable, the bearer token is missing, or no public URL
 * is configured.
 */
export async function fetchAssistantIngressUrl(
  runtimeUrl: string,
  bearerToken?: string,
): Promise<string | undefined> {
  if (!bearerToken) return undefined;
  try {
    const resp = await loopbackSafeFetch(
      `${runtimeUrl}/integrations/ingress/config`,
      {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (resp.ok) {
      const body = (await resp.json()) as {
        publicBaseUrl?: string;
        managedCallbacks?: boolean;
      };
      // Ignore managed-callback URLs — those belong to the platform, not the
      // self-hosted assistant's own ingress.
      if (body.managedCallbacks) return undefined;
      return body.publicBaseUrl || undefined;
    }
  } catch {
    // Best-effort
  }
  return undefined;
}

/**
 * Determine the version that was running before the current one.
 *
 * Checks (in order):
 *  1. `entry.previousVersion` (saved by the upgrade flow from health).
 *  2. The releases list from the platform API — finds the version
 *     immediately before `currentVersion`.
 *
 * Returns `undefined` when neither source yields a result.
 */
export async function fetchPreviousVersion(
  currentVersion: string | undefined,
  previousVersionFromLockfile: string | undefined,
): Promise<string | undefined> {
  // 1. Lockfile-cached value (written during upgrade from health endpoint)
  if (previousVersionFromLockfile) return previousVersionFromLockfile;

  // 2. Derive from releases list
  if (!currentVersion) return undefined;
  const releases = await fetchReleases();
  if (!releases) return undefined;

  const normalizedCurrent = stripVersionPrefix(currentVersion);

  // Releases are ordered newest-first; find the entry right after the
  // current version (i.e. the one that was running before the upgrade).
  const idx = releases.findIndex(
    (r) => stripVersionPrefix(r.version ?? "") === normalizedCurrent,
  );
  if (idx >= 0 && idx + 1 < releases.length) {
    return releases[idx + 1].version;
  }
  return undefined;
}

/**
 * Poll the gateway `/readyz` endpoint until the assistant reports migrations
 * ready or the timeout elapses. Returns whether the assistant became ready.
 *
 * Readiness is classified from the response BODY, not the status code: the
 * assistant's `/readyz` (forwarded through the gateway proxy) returns 200
 * with `ready: false` while DB migrations run — the k8s keep-the-pod contract
 * — so `resp.ok` alone would declare an upgrade successful before its
 * migrations settle and make the caller's rollback path unreachable. A
 * terminally failed migration returns immediately so rollback/restore can run
 * without burning the timeout.
 */
export async function waitForReady(runtimeUrl: string): Promise<boolean> {
  const readyUrl = `${runtimeUrl}/readyz`;
  const start = Date.now();

  while (Date.now() - start < DOCKER_READY_TIMEOUT_MS) {
    try {
      const resp = await loopbackSafeFetch(readyUrl, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json().catch(() => null)) as {
        status?: string;
        upstream?: number;
      } | null;
      const readiness = classifyReadyzResponse(resp.ok, body);
      if (readiness === "ready") {
        const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Assistant ready after ${elapsedSec}s`);
        return true;
      }
      if (readiness === "failed") {
        console.log(
          "Assistant database migrations FAILED — treating the assistant as not ready so recovery can run.",
        );
        return false;
      }
      const parts = [body?.status].filter(Boolean);
      if (body?.upstream != null) parts.push(`upstream=${body.upstream}`);
      const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
      console.log(`Readiness check: ${resp.status}${detail} (retrying...)`);
    } catch {
      // Connection refused / timeout — not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return false;
}

/**
 * Best-effort broadcast of an upgrade lifecycle event to connected clients
 * via the gateway's upgrade-broadcast proxy. Uses guardian token auth.
 * Failures are logged but never block the upgrade flow.
 */
export async function broadcastUpgradeEvent(
  gatewayUrl: string,
  assistantId: string,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    const token = loadGuardianToken(assistantId);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token?.accessToken) {
      headers["Authorization"] = `Bearer ${token.accessToken}`;
    }
    await loopbackSafeFetch(`${gatewayUrl}/v1/admin/upgrade-broadcast`, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort — gateway/daemon may already be shutting down or not yet ready
  }
}

/**
 * Best-effort workspace git commit via the gateway's workspace-commit endpoint.
 * Uses guardian token auth. Failures are silently swallowed — this should never
 * block upgrade or rollback flows.
 */
export async function commitWorkspaceViaGateway(
  gatewayUrl: string,
  assistantId: string,
  message: string,
): Promise<void> {
  try {
    const token = loadGuardianToken(assistantId);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token?.accessToken) {
      headers["Authorization"] = `Bearer ${token.accessToken}`;
    }
    await loopbackSafeFetch(`${gatewayUrl}/v1/admin/workspace-commit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort — gateway/daemon may already be shutting down or not yet ready
  }
}

/**
 * Roll back DB and workspace migrations to a target state via the gateway.
 * Best-effort — failures are logged but never block the rollback flow.
 */
export async function rollbackMigrations(
  gatewayUrl: string,
  assistantId: string,
  targetDbVersion?: number,
  targetWorkspaceMigrationId?: string,
  rollbackToRegistryCeiling?: boolean,
): Promise<boolean> {
  if (
    !rollbackToRegistryCeiling &&
    targetDbVersion === undefined &&
    targetWorkspaceMigrationId === undefined
  ) {
    return false;
  }
  try {
    const token = loadGuardianToken(assistantId);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token?.accessToken) {
      headers["Authorization"] = `Bearer ${token.accessToken}`;
    }
    const body: Record<string, unknown> = {};
    if (targetDbVersion !== undefined) body.targetDbVersion = targetDbVersion;
    if (targetWorkspaceMigrationId !== undefined)
      body.targetWorkspaceMigrationId = targetWorkspaceMigrationId;
    if (rollbackToRegistryCeiling) body.rollbackToRegistryCeiling = true;

    // The CLI can learn of a migration failure (via the forwarded /readyz
    // body) up to a couple of seconds before the gateway's own assistant
    // health poll opens its traffic gate — a POST landing in that window
    // gets 503 {status:"starting"}. Retry through it rather than silently
    // skipping the rollback.
    const startingGateDeadline = Date.now() + 15_000;
    let resp: Response;
    for (;;) {
      resp = await loopbackSafeFetch(
        `${gatewayUrl}/v1/admin/rollback-migrations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (resp.ok) break;
      const text = await resp.text();
      let gatewayStarting = false;
      try {
        gatewayStarting =
          (JSON.parse(text) as { status?: string }).status === "starting";
      } catch {
        // Non-JSON error body — not the starting gate.
      }
      if (gatewayStarting && Date.now() < startingGateDeadline) {
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      console.warn(`⚠️  Migration rollback failed (${resp.status}): ${text}`);
      return false;
    }
    const result = (await resp.json()) as {
      rolledBack?: { db?: string[]; workspace?: string[] };
    };
    const dbCount = result.rolledBack?.db?.length ?? 0;
    const wsCount = result.rolledBack?.workspace?.length ?? 0;
    if (dbCount > 0 || wsCount > 0) {
      console.log(
        `   Rolled back ${dbCount} DB migration(s) and ${wsCount} workspace migration(s)`,
      );
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  Migration rollback failed: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared Docker rollback orchestration
// ---------------------------------------------------------------------------

export interface PerformDockerRollbackOptions {
  /** Specific version to roll back to. */
  targetVersion?: string;
}

/**
 * Perform a Docker rollback to a target version. Reusable by both `rollback.ts`
 * (targeted version rollback) and `restore.ts` (version + data restore).
 *
 * This function handles the full lifecycle:
 * - Version validation (target must be older than current)
 * - Image resolution and pulling
 * - Migration ceiling lookup and pre-swap rollback
 * - Container stop/start with target images
 * - Readiness check
 * - Lockfile update with rollback state
 * - Auto-rollback on failure
 */
export async function performDockerRollback(
  entry: AssistantEntry,
  options: PerformDockerRollbackOptions,
): Promise<void> {
  const { targetVersion } = options;

  if (!targetVersion) {
    throw new Error("targetVersion is required for performDockerRollback");
  }

  // Fetch the current running version from the health endpoint.
  let currentVersion: string | undefined;

  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);

  // Resolve Docker image refs for the target version
  console.log("🔍 Resolving image references...");
  const { imageTags: targetImageTags } = await resolveImageRefs(targetVersion);

  // Capture current image digests for auto-rollback on failure
  console.log("📸 Capturing current image references for rollback...");
  const currentImageRefs = await captureImageRefs(res);

  // Capture current migration state and running version for rollback targeting
  let preMigrationState: {
    dbVersion?: number;
    lastWorkspaceMigrationId?: string;
  } = {};
  try {
    const healthResp = await loopbackSafeFetch(
      `${entry.runtimeUrl}/healthz?include=migrations`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (healthResp.ok) {
      const health = (await healthResp.json()) as {
        version?: string;
        migrations?: { dbVersion?: number; lastWorkspaceMigrationId?: string };
      };
      preMigrationState = health.migrations ?? {};
      currentVersion = health.version;
    }
  } catch {
    // Best-effort
  }

  // Validate target version < current version
  if (!currentVersion) {
    console.warn(
      "⚠️  Could not determine current version from health endpoint — skipping version-direction check.\n",
    );
  }
  if (currentVersion) {
    const cmp = compareVersions(targetVersion, currentVersion);
    if (cmp !== null) {
      if (cmp > 0) {
        const msg =
          "Cannot roll back to a newer version. Use `vellum upgrade` instead.";
        console.error(msg);
        emitCliError("VERSION_DIRECTION", msg);
        process.exit(1);
      }
      if (cmp === 0) {
        const msg = `Already on version ${targetVersion}. Nothing to roll back to.`;
        console.error(msg);
        emitCliError("VERSION_DIRECTION", msg);
        process.exit(1);
      }
    }
  }

  // Persist rollback state to lockfile BEFORE any destructive changes
  if (entry.containerInfo) {
    const rollbackEntry: AssistantEntry = {
      ...entry,
      previousContainerInfo: { ...entry.containerInfo },
      previousVersion: currentVersion,
      previousDbMigrationVersion: preMigrationState.dbVersion,
      previousWorkspaceMigrationId: preMigrationState.lastWorkspaceMigrationId,
    };
    saveAssistantEntry(rollbackEntry);
    if (currentVersion) {
      console.log(`   Saved rollback state: ${currentVersion}\n`);
    }
  }

  // Record rollback start in workspace git history
  await commitWorkspaceViaGateway(
    entry.runtimeUrl,
    entry.assistantId,
    buildUpgradeCommitMessage({
      action: "rollback",
      phase: "starting",
      from: currentVersion ?? "unknown",
      to: targetVersion,
      topology: "docker",
      assistantId: entry.assistantId,
    }),
  );

  console.log(
    `🔄 Rolling back Docker assistant '${instanceName}' to ${targetVersion}...\n`,
  );

  // Create a pre-rollback backup as a safety net
  console.log("📦 Creating pre-rollback backup...");
  const preRollbackBackupPath = await createBackup(
    entry.runtimeUrl,
    entry.assistantId,
    {
      prefix: `${entry.assistantId}-pre-upgrade`,
      description: `Pre-rollback snapshot before ${currentVersion ?? "unknown"} → ${targetVersion}`,
    },
  );
  if (preRollbackBackupPath) {
    console.log(`   Backup saved: ${preRollbackBackupPath}\n`);
    pruneOldBackups(entry.assistantId, 3);
  } else {
    console.warn("⚠️  Pre-rollback backup failed (continuing with rollback)\n");
  }

  const {
    bootstrapSecret,
    cesServiceToken,
    signingKey,
    extraAssistantEnv,
    extraGatewayEnv,
  } = await captureReplayState(res);

  // Parse gateway port from entry's runtimeUrl
  let gatewayPort = GATEWAY_INTERNAL_PORT;
  try {
    const parsed = new URL(entry.runtimeUrl);
    const port = parseInt(parsed.port, 10);
    if (!isNaN(port)) {
      gatewayPort = port;
    }
  } catch {
    // use default
  }

  // Recover the assistant host port from the entry, fall back to default.
  const assistantPort =
    entry.containerInfo?.assistantPort ?? ASSISTANT_INTERNAL_PORT;

  // Broadcast SSE "starting" event
  console.log("📢 Notifying connected clients...");
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildStartingEvent(targetVersion),
  );
  // Brief pause for SSE delivery
  await new Promise((r) => setTimeout(r, 500));

  // Pull target version Docker images
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.DOWNLOADING),
  );
  console.log("📦 Pulling target Docker images...");
  const pullImages: Array<[string, string]> = [
    ["assistant", targetImageTags.assistant],
    ["gateway", targetImageTags.gateway],
    ["credential-executor", targetImageTags["credential-executor"]],
  ];
  try {
    for (const [service, image] of pullImages) {
      console.log(`   Pulling ${service}: ${image}`);
      await exec("docker", ["pull", image]);
    }
  } catch (pullErr) {
    const detail = pullErr instanceof Error ? pullErr.message : String(pullErr);
    console.error(`\n❌ Failed to pull Docker images: ${detail}`);
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(currentVersion ?? "unknown", false),
    );
    emitCliError("IMAGE_PULL_FAILED", "Failed to pull Docker images", detail);
    process.exit(1);
  }
  console.log("✅ Docker images pulled\n");

  // Progress: switching version
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.SWITCHING),
  );

  // Stop containers, migrate security files, start with target images
  console.log("🛑 Stopping existing containers...");
  await stopContainers(res);
  console.log("✅ Containers stopped\n");

  console.log("🚀 Starting containers with target version...");
  await startContainers(
    {
      signingKey,
      bootstrapSecret,
      cesServiceToken,
      extraAssistantEnv,
      extraGatewayEnv,
      gatewayPort,
      assistantPort,
      imageTags: targetImageTags,
      instanceName,
      res,
    },
    (msg) => console.log(msg),
  );
  console.log("✅ Containers started\n");

  // Wait for readiness
  console.log("Waiting for assistant to become ready...");
  const ready = await waitForReady(entry.runtimeUrl);

  if (ready) {
    // Success path

    // Post-swap migration rollback: ask the now-running old daemon to roll
    // back any migrations above its own registry ceiling.
    await rollbackMigrations(
      entry.runtimeUrl,
      entry.assistantId,
      undefined,
      undefined,
      true,
    );

    // Capture new digests from the rolled-back containers
    const newDigests = await captureImageRefs(res);

    // Swap current/previous state to enable "rollback the rollback"
    const updatedEntry: AssistantEntry = {
      ...entry,
      containerInfo: {
        assistantImage: targetImageTags.assistant,
        gatewayImage: targetImageTags.gateway,
        cesImage: targetImageTags["credential-executor"],
        assistantDigest: newDigests?.assistant,
        gatewayDigest: newDigests?.gateway,
        cesDigest: newDigests?.["credential-executor"],
        networkName: res.network,
        assistantPort,
      },
      previousContainerInfo: entry.containerInfo,
      previousDbMigrationVersion: preMigrationState.dbVersion,
      previousWorkspaceMigrationId: preMigrationState.lastWorkspaceMigrationId,
      preUpgradeBackupPath: undefined,
    };
    saveAssistantEntry(updatedEntry);

    // Notify clients that the rollback succeeded
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(targetVersion, true),
    );

    // Record successful rollback in workspace git history
    await commitWorkspaceViaGateway(
      entry.runtimeUrl,
      entry.assistantId,
      buildUpgradeCommitMessage({
        action: "rollback",
        phase: "complete",
        from: currentVersion ?? "unknown",
        to: targetVersion,
        topology: "docker",
        assistantId: entry.assistantId,
        result: "success",
      }),
    );

    console.log(
      `\n✅ Docker assistant '${instanceName}' rolled back to ${targetVersion}.`,
    );
  } else {
    // Failure path — attempt auto-rollback to original version
    console.error(`\n❌ Containers failed to become ready within the timeout.`);

    const logDir = await captureUpgradeFailureLogs(
      res,
      `${instanceName}-rollback-failure`,
    );
    if (logDir) {
      console.log(`📋 Container logs saved to: ${logDir}`);
    }

    if (currentImageRefs) {
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildProgressEvent(UPGRADE_PROGRESS.REVERTING),
      );
      console.log(`\n🔄 Rolling back to original version...`);
      try {
        // Attempt to roll back migrations before reverting containers
        if (
          preMigrationState.dbVersion !== undefined ||
          preMigrationState.lastWorkspaceMigrationId !== undefined
        ) {
          console.log("🔄 Reverting database changes...");
          await broadcastUpgradeEvent(
            entry.runtimeUrl,
            entry.assistantId,
            buildProgressEvent(UPGRADE_PROGRESS.REVERTING_MIGRATIONS),
          );
          await rollbackMigrations(
            entry.runtimeUrl,
            entry.assistantId,
            preMigrationState.dbVersion,
            preMigrationState.lastWorkspaceMigrationId,
          );
        }

        await stopContainers(res);

        await startContainers(
          {
            signingKey,
            bootstrapSecret,
            cesServiceToken,
            extraAssistantEnv,
            extraGatewayEnv,
            gatewayPort,
            assistantPort,
            imageTags: currentImageRefs,
            instanceName,
            res,
          },
          (msg) => console.log(msg),
        );

        let revertReady = await waitForReady(entry.runtimeUrl);
        let restoredViaFailedState = false;
        if (!revertReady && preRollbackBackupPath) {
          // The reverted stack can itself report terminally failed
          // migrations — the state the failed-state migrations/import
          // exemption exists to repair. The import replaces the DB
          // wholesale, but the failed readiness latch only clears on
          // restart, so restart the containers and re-check.
          console.log(
            `📦 Reverted stack not ready — attempting pre-rollback backup restore...`,
          );
          console.log(`   Source: ${preRollbackBackupPath}`);
          restoredViaFailedState = await restoreBackup(
            entry.runtimeUrl,
            entry.assistantId,
            preRollbackBackupPath,
          );
          if (restoredViaFailedState) {
            console.log(
              "   Backup imported — restarting containers to complete recovery...",
            );
            await stopContainers(res);
            await startContainers(
              {
                signingKey,
                bootstrapSecret,
                cesServiceToken,
                extraAssistantEnv,
                extraGatewayEnv,
                gatewayPort,
                assistantPort,
                imageTags: currentImageRefs,
                instanceName,
                res,
              },
              (msg) => console.log(msg),
            );
            revertReady = await waitForReady(entry.runtimeUrl);
          }
        }
        if (revertReady) {
          // Restore from pre-rollback backup on failure
          if (restoredViaFailedState) {
            console.log(
              "   ✅ Data restored during failed-state recovery above\n",
            );
          } else if (preRollbackBackupPath) {
            await broadcastUpgradeEvent(
              entry.runtimeUrl,
              entry.assistantId,
              buildProgressEvent(UPGRADE_PROGRESS.RESTORING),
            );
            console.log(`📦 Restoring data from pre-rollback backup...`);
            console.log(`   Source: ${preRollbackBackupPath}`);
            const restored = await restoreBackup(
              entry.runtimeUrl,
              entry.assistantId,
              preRollbackBackupPath,
            );
            if (restored) {
              console.log("   ✅ Data restored successfully\n");
            } else {
              console.warn(
                "   ⚠️  Data restore failed (auto-rollback continues without data restoration)\n",
              );
            }
          }

          // Restore lockfile state
          const revertDigests = await captureImageRefs(res);
          const revertedEntry: AssistantEntry = {
            ...entry,
            containerInfo: {
              assistantImage:
                entry.containerInfo?.assistantImage ??
                currentImageRefs.assistant,
              gatewayImage:
                entry.containerInfo?.gatewayImage ?? currentImageRefs.gateway,
              cesImage:
                entry.containerInfo?.cesImage ??
                currentImageRefs["credential-executor"],
              assistantDigest:
                revertDigests?.assistant ?? currentImageRefs.assistant,
              gatewayDigest: revertDigests?.gateway ?? currentImageRefs.gateway,
              cesDigest:
                revertDigests?.["credential-executor"] ??
                currentImageRefs["credential-executor"],
              networkName: res.network,
              assistantPort,
            },
            previousContainerInfo: undefined,
            previousDbMigrationVersion: undefined,
            previousWorkspaceMigrationId: undefined,
            preUpgradeBackupPath: undefined,
          };
          saveAssistantEntry(revertedEntry);

          await broadcastUpgradeEvent(
            entry.runtimeUrl,
            entry.assistantId,
            buildCompleteEvent(
              currentVersion ?? "unknown",
              false,
              currentVersion,
            ),
          );

          console.log(
            `\n⚠️  Rolled back to original version. Rollback to ${targetVersion} failed.`,
          );
          emitCliError(
            "READINESS_TIMEOUT",
            `Rollback to ${targetVersion} failed: containers did not become ready. Rolled back to original version.`,
          );
        } else {
          console.error(
            `\n❌ Auto-rollback also failed. Manual intervention required.`,
          );
          console.log(
            `   Check logs with: docker logs -f ${res.assistantContainer}`,
          );
          await broadcastUpgradeEvent(
            entry.runtimeUrl,
            entry.assistantId,
            buildCompleteEvent(currentVersion ?? "unknown", false),
          );
          emitCliError(
            "ROLLBACK_FAILED",
            "Auto-rollback also failed after readiness timeout. Manual intervention required.",
          );
        }
      } catch (revertErr) {
        const revertDetail =
          revertErr instanceof Error ? revertErr.message : String(revertErr);
        console.error(`\n❌ Auto-rollback failed: ${revertDetail}`);
        console.error(`   Manual intervention required.`);
        console.log(
          `   Check logs with: docker logs -f ${res.assistantContainer}`,
        );
        await broadcastUpgradeEvent(
          entry.runtimeUrl,
          entry.assistantId,
          buildCompleteEvent(currentVersion ?? "unknown", false),
        );
        emitCliError(
          "ROLLBACK_FAILED",
          "Auto-rollback failed after readiness timeout. Manual intervention required.",
          revertDetail,
        );
      }
    } else {
      console.log(`   No previous images available for auto-rollback.`);
      console.log(
        `   Check logs with: docker logs -f ${res.assistantContainer}`,
      );
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildCompleteEvent(currentVersion ?? "unknown", false),
      );
      emitCliError(
        "ROLLBACK_NO_STATE",
        "Containers failed to become ready and no previous images available for auto-rollback.",
      );
    }

    process.exit(1);
  }
}

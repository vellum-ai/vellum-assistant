import { randomBytes } from "crypto";
import { join } from "path";

import type { AssistantEntry } from "./assistant-config.js";
import { saveAssistantEntry } from "./assistant-config.js";
import { createBackup, pruneOldBackups, restoreBackup } from "./backup-ops.js";
import { emitCliError } from "./cli-error.js";
import {
  captureImageRefs,
  DOCKER_READY_TIMEOUT_MS,
  dockerResourceNames,
  GATEWAY_INTERNAL_PORT,
  migrateCesSecurityFiles,
  migrateGatewaySecurityFiles,
  startContainers,
  stopContainers,
} from "./docker.js";
import { loadGuardianToken } from "./guardian-token.js";
import { getPlatformUrl } from "./platform-client.js";
import { resolveImageRefs } from "./platform-releases.js";
import { exec, execOutput } from "./step-runner.js";
import { parseVersion } from "./version-compat.js";
import { commitWorkspaceState } from "./workspace-git.js";

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
  topology: "docker" | "managed";
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
 * Environment variable keys that are set by CLI run arguments and should
 * not be replayed from a captured container environment during upgrades
 * or rollbacks. Shared between upgrade.ts and rollback.ts.
 */
export const CONTAINER_ENV_EXCLUDE_KEYS: ReadonlySet<string> = new Set([
  "CES_SERVICE_TOKEN",
  "VELLUM_ASSISTANT_NAME",
  "RUNTIME_HTTP_HOST",
  "PATH",
  "ACTOR_TOKEN_SIGNING_KEY",
]);

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
 * Poll the gateway `/readyz` endpoint until it returns 200 or the timeout
 * elapses. Returns whether the assistant became ready.
 */
export async function waitForReady(runtimeUrl: string): Promise<boolean> {
  const readyUrl = `${runtimeUrl}/readyz`;
  const start = Date.now();

  while (Date.now() - start < DOCKER_READY_TIMEOUT_MS) {
    try {
      const resp = await fetch(readyUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Assistant ready after ${elapsedSec}s`);
        return true;
      }
      let detail = "";
      try {
        const body = await resp.text();
        const json = JSON.parse(body);
        const parts = [json.status];
        if (json.upstream != null) parts.push(`upstream=${json.upstream}`);
        detail = ` — ${parts.join(", ")}`;
      } catch {
        // ignore parse errors
      }
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
    await fetch(`${gatewayUrl}/v1/admin/upgrade-broadcast`, {
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

    const resp = await fetch(`${gatewayUrl}/v1/admin/rollback-migrations`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
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

  const currentVersion = entry.serviceGroupVersion;

  // Validate target version < current version
  if (currentVersion) {
    const current = parseVersion(currentVersion);
    const target = parseVersion(targetVersion);
    if (current && target) {
      const isNewer = (() => {
        if (target.major !== current.major) return target.major > current.major;
        if (target.minor !== current.minor) return target.minor > current.minor;
        return target.patch > current.patch;
      })();
      if (isNewer) {
        const msg =
          "Cannot roll back to a newer version. Use `vellum upgrade` instead.";
        console.error(msg);
        emitCliError("VERSION_DIRECTION", msg);
        process.exit(1);
      }
      const isSame =
        target.major === current.major &&
        target.minor === current.minor &&
        target.patch === current.patch;
      if (isSame) {
        const msg = `Already on version ${targetVersion}. Nothing to roll back to.`;
        console.error(msg);
        emitCliError("VERSION_DIRECTION", msg);
        process.exit(1);
      }
    }
  }

  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);
  const workspaceDir = entry.resources
    ? join(entry.resources.instanceDir, ".vellum", "workspace")
    : undefined;

  // Resolve Docker image refs for the target version
  console.log("🔍 Resolving image references...");
  const { imageTags: targetImageTags } = await resolveImageRefs(targetVersion);

  // Fetch target migration ceiling from releases API
  let targetMigrationCeiling: {
    dbVersion?: number;
    workspaceMigrationId?: string;
  } = {};
  try {
    const platformUrl = getPlatformUrl();
    const releasesResp = await fetch(
      `${platformUrl}/v1/releases/?stable=true`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (releasesResp.ok) {
      const releases = (await releasesResp.json()) as Array<{
        version: string;
        db_migration_version?: number | null;
        last_workspace_migration_id?: string;
      }>;
      const normalizedTag = targetVersion.replace(/^v/, "");
      const targetRelease = releases.find(
        (r) => r.version?.replace(/^v/, "") === normalizedTag,
      );
      if (
        targetRelease?.db_migration_version != null ||
        targetRelease?.last_workspace_migration_id
      ) {
        targetMigrationCeiling = {
          dbVersion: targetRelease.db_migration_version ?? undefined,
          workspaceMigrationId:
            targetRelease.last_workspace_migration_id || undefined,
        };
      }
    }
  } catch {
    // Best-effort — fall back to rollbackToRegistryCeiling post-swap
  }

  // Capture current image digests for auto-rollback on failure
  console.log("📸 Capturing current image references for rollback...");
  const currentImageRefs = await captureImageRefs(res);

  // Capture current migration state for rollback targeting
  let preMigrationState: {
    dbVersion?: number;
    lastWorkspaceMigrationId?: string;
  } = {};
  try {
    const healthResp = await fetch(
      `${entry.runtimeUrl}/healthz?include=migrations`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (healthResp.ok) {
      const health = (await healthResp.json()) as {
        migrations?: { dbVersion?: number; lastWorkspaceMigrationId?: string };
      };
      preMigrationState = health.migrations ?? {};
    }
  } catch {
    // Best-effort
  }

  // Persist rollback state to lockfile BEFORE any destructive changes
  if (entry.serviceGroupVersion && entry.containerInfo) {
    const rollbackEntry: AssistantEntry = {
      ...entry,
      previousServiceGroupVersion: entry.serviceGroupVersion,
      previousContainerInfo: { ...entry.containerInfo },
      previousDbMigrationVersion: preMigrationState.dbVersion,
      previousWorkspaceMigrationId: preMigrationState.lastWorkspaceMigrationId,
    };
    saveAssistantEntry(rollbackEntry);
    console.log(`   Saved rollback state: ${entry.serviceGroupVersion}\n`);
  }

  // Record rollback start in workspace git history
  if (workspaceDir) {
    try {
      await commitWorkspaceState(
        workspaceDir,
        buildUpgradeCommitMessage({
          action: "rollback",
          phase: "starting",
          from: currentVersion ?? "unknown",
          to: targetVersion,
          topology: "docker",
          assistantId: entry.assistantId,
        }),
      );
    } catch (err) {
      console.warn(
        `⚠️  Failed to create pre-rollback workspace commit: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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

  // Capture container env, extract secrets
  console.log("💾 Capturing existing container environment...");
  const capturedEnv = await captureContainerEnv(res.assistantContainer);
  console.log(
    `   Captured ${Object.keys(capturedEnv).length} env var(s) from ${res.assistantContainer}\n`,
  );

  const cesServiceToken =
    capturedEnv["CES_SERVICE_TOKEN"] || randomBytes(32).toString("hex");

  const signingKey =
    capturedEnv["ACTOR_TOKEN_SIGNING_KEY"] || randomBytes(32).toString("hex");

  // Build extra env vars, excluding keys managed by serviceDockerRunArgs
  const envKeysSetByRunArgs = new Set(CONTAINER_ENV_EXCLUDE_KEYS);
  for (const envVar of ["ANTHROPIC_API_KEY", "VELLUM_PLATFORM_URL"]) {
    if (process.env[envVar]) {
      envKeysSetByRunArgs.add(envVar);
    }
  }
  const extraAssistantEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(capturedEnv)) {
    if (!envKeysSetByRunArgs.has(key)) {
      extraAssistantEnv[key] = value;
    }
  }

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

  // Pre-swap migration rollback to target ceiling on the CURRENT (newer) daemon
  let preSwapRollbackOk = true;
  if (
    targetMigrationCeiling.dbVersion !== undefined ||
    targetMigrationCeiling.workspaceMigrationId !== undefined
  ) {
    console.log("🔄 Reverting database changes...");
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildProgressEvent(UPGRADE_PROGRESS.REVERTING_MIGRATIONS),
    );
    preSwapRollbackOk = await rollbackMigrations(
      entry.runtimeUrl,
      entry.assistantId,
      targetMigrationCeiling.dbVersion,
      targetMigrationCeiling.workspaceMigrationId,
    );
  }

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

  console.log("🔄 Migrating security files to gateway volume...");
  await migrateGatewaySecurityFiles(res, (msg) => console.log(msg));

  console.log("🔄 Migrating credential files to CES security volume...");
  await migrateCesSecurityFiles(res, (msg) => console.log(msg));

  console.log("🚀 Starting containers with target version...");
  await startContainers(
    {
      signingKey,
      cesServiceToken,
      extraAssistantEnv,
      gatewayPort,
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

    // Post-swap migration rollback fallback: if pre-swap rollback failed
    // or no ceiling metadata was available, ask the now-running old daemon
    // to roll back migrations above its own registry ceiling.
    if (
      !preSwapRollbackOk ||
      (targetMigrationCeiling.dbVersion === undefined &&
        targetMigrationCeiling.workspaceMigrationId === undefined)
    ) {
      await rollbackMigrations(
        entry.runtimeUrl,
        entry.assistantId,
        undefined,
        undefined,
        true,
      );
    }

    // Capture new digests from the rolled-back containers
    const newDigests = await captureImageRefs(res);

    // Swap current/previous state to enable "rollback the rollback"
    const updatedEntry: AssistantEntry = {
      ...entry,
      serviceGroupVersion: targetVersion,
      containerInfo: {
        assistantImage: targetImageTags.assistant,
        gatewayImage: targetImageTags.gateway,
        cesImage: targetImageTags["credential-executor"],
        assistantDigest: newDigests?.assistant,
        gatewayDigest: newDigests?.gateway,
        cesDigest: newDigests?.["credential-executor"],
        networkName: res.network,
      },
      previousServiceGroupVersion: entry.serviceGroupVersion,
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
    if (workspaceDir) {
      try {
        await commitWorkspaceState(
          workspaceDir,
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
      } catch (err) {
        console.warn(
          `⚠️  Failed to create post-rollback workspace commit: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(
      `\n✅ Docker assistant '${instanceName}' rolled back to ${targetVersion}.`,
    );
  } else {
    // Failure path — attempt auto-rollback to original version
    console.error(`\n❌ Containers failed to become ready within the timeout.`);

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

        await migrateGatewaySecurityFiles(res, (msg) => console.log(msg));
        await migrateCesSecurityFiles(res, (msg) => console.log(msg));

        await startContainers(
          {
            signingKey,
            cesServiceToken,
            extraAssistantEnv,
            gatewayPort,
            imageTags: currentImageRefs,
            instanceName,
            res,
          },
          (msg) => console.log(msg),
        );

        const revertReady = await waitForReady(entry.runtimeUrl);
        if (revertReady) {
          // Restore from pre-rollback backup on failure
          if (preRollbackBackupPath) {
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
            },
            previousServiceGroupVersion: undefined,
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

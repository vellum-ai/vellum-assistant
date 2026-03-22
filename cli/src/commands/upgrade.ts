import { randomBytes } from "crypto";
import { join } from "node:path";

import cliPkg from "../../package.json";

import {
  findAssistantByName,
  getActiveAssistant,
  loadAllAssistants,
  saveAssistantEntry,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import {
  captureImageRefs,
  GATEWAY_INTERNAL_PORT,
  dockerResourceNames,
  migrateCesSecurityFiles,
  migrateGatewaySecurityFiles,
  startContainers,
  stopContainers,
} from "../lib/docker";
import { resolveImageRefs } from "../lib/platform-releases";
import {
  fetchOrganizationId,
  getPlatformUrl,
  readPlatformToken,
} from "../lib/platform-client";
import {
  loadBootstrapSecret,
  saveBootstrapSecret,
} from "../lib/guardian-token";
import {
  createBackup,
  pruneOldBackups,
  restoreBackup,
} from "../lib/backup-ops.js";
import { emitCliError, categorizeUpgradeError } from "../lib/cli-error.js";
import { exec } from "../lib/step-runner.js";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildProgressEvent,
  buildStartingEvent,
  buildUpgradeCommitMessage,
  captureContainerEnv,
  CONTAINER_ENV_EXCLUDE_KEYS,
  rollbackMigrations,
  UPGRADE_PROGRESS,
  waitForReady,
} from "../lib/upgrade-lifecycle.js";
import { parseVersion } from "../lib/version-compat.js";
import { commitWorkspaceState } from "../lib/workspace-git.js";

interface UpgradeArgs {
  name: string | null;
  version: string | null;
}

function parseArgs(): UpgradeArgs {
  const args = process.argv.slice(3);
  let name: string | null = null;
  let version: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum upgrade [<name>] [options]");
      console.log("");
      console.log("Upgrade an assistant to the latest version.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>               Name of the assistant to upgrade (default: active or only assistant)",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --version <version>  Target version to upgrade to (default: latest)",
      );
      console.log("");
      console.log("Examples:");
      console.log(
        "  vellum upgrade                              # Upgrade the active assistant to the latest version",
      );
      console.log(
        "  vellum upgrade my-assistant                  # Upgrade a specific assistant by name",
      );
      console.log(
        "  vellum upgrade my-assistant --version v1.2.3 # Upgrade to a specific version",
      );
      process.exit(0);
    } else if (arg === "--version") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --version requires a value");
        emitCliError("UNKNOWN", "--version requires a value");
        process.exit(1);
      }
      version = next;
      i++;
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
      emitCliError("UNKNOWN", `Unknown option '${arg}'`);
      process.exit(1);
    }
  }

  return { name, version };
}

function resolveCloud(entry: AssistantEntry): string {
  if (entry.cloud) {
    return entry.cloud;
  }
  if (entry.project) {
    return "gcp";
  }
  if (entry.sshUser) {
    return "custom";
  }
  return "local";
}

/**
 * Resolve which assistant to target for the upgrade command. Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `vellum use`
 * 3. Sole assistant (when exactly one exists)
 */
function resolveTargetAssistant(nameArg: string | null): AssistantEntry {
  if (nameArg) {
    const entry = findAssistantByName(nameArg);
    if (!entry) {
      console.error(`No assistant found with name '${nameArg}'.`);
      emitCliError(
        "ASSISTANT_NOT_FOUND",
        `No assistant found with name '${nameArg}'.`,
      );
      process.exit(1);
    }
    return entry;
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
  }

  const all = loadAllAssistants();
  if (all.length === 1) return all[0];

  if (all.length === 0) {
    const msg = "No assistants found. Run 'vellum hatch' first.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  } else {
    const msg =
      "Multiple assistants found. Specify a name or set an active assistant with 'vellum use <name>'.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  }
  process.exit(1);
}

async function upgradeDocker(
  entry: AssistantEntry,
  version: string | null,
): Promise<void> {
  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);
  const workspaceDir = entry.resources
    ? join(entry.resources.instanceDir, ".vellum", "workspace")
    : null;

  const versionTag =
    version ?? (cliPkg.version ? `v${cliPkg.version}` : "latest");
  console.log("🔍 Resolving image references...");
  const { imageTags } = await resolveImageRefs(versionTag);

  console.log(
    `🔄 Upgrading Docker assistant '${instanceName}' to ${versionTag}...\n`,
  );

  // Capture rollback state from existing containers BEFORE pulling new
  // images or stopping anything.  captureImageRefs uses the immutable
  // image digest ({{.Image}}), but capturing first keeps the intent
  // explicit and avoids relying on container-inspect ordering subtleties.
  console.log("📸 Capturing current image references for rollback...");
  const previousImageRefs = await captureImageRefs(res);
  if (previousImageRefs) {
    console.log(
      `   Captured refs for ${Object.keys(previousImageRefs).length} service(s)\n`,
    );
  } else {
    console.log(
      "   Could not capture all container refs (fresh install or partial deployment)\n",
    );
  }

  // Capture current migration state for rollback targeting.
  // Must happen while daemon is still running (before containers are stopped).
  let preMigrationState: {
    dbVersion?: number;
    lastWorkspaceMigrationId?: string;
  } = {};
  try {
    const healthResp = await fetch(
      `${entry.runtimeUrl}/healthz?include=migrations`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    if (healthResp.ok) {
      const health = (await healthResp.json()) as {
        migrations?: { dbVersion?: number; lastWorkspaceMigrationId?: string };
      };
      preMigrationState = health.migrations ?? {};
    }
  } catch {
    // Best-effort — if we can't get migration state, rollback will skip migration reversal
  }

  // Detect if this upgrade is actually a downgrade (user picked an older
  // version via the version picker). Used after readiness succeeds to align
  // the DB schema with the now-running old daemon.
  const currentVersion = entry.serviceGroupVersion;
  const isDowngrade =
    currentVersion &&
    versionTag &&
    (() => {
      const current = parseVersion(currentVersion);
      const target = parseVersion(versionTag);
      if (!current || !target) return false;
      if (target.major !== current.major) return target.major < current.major;
      if (target.minor !== current.minor) return target.minor < current.minor;
      return target.patch < current.patch;
    })();

  // For downgrades, fetch the target version's migration ceiling from the
  // releases API. This tells us exactly which DB migration version and
  // workspace migration the target version expects, enabling a precise
  // rollback on the CURRENT (newer) daemon before swapping containers.
  let targetMigrationCeiling: {
    dbVersion?: number;
    workspaceMigrationId?: string;
  } = {};
  if (isDowngrade) {
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
        const normalizedTag = versionTag.replace(/^v/, "");
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
  }

  // Persist rollback state to lockfile BEFORE any destructive changes.
  // This enables the `vellum rollback` command to restore the previous version.
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

  // Record version transition start in workspace git history
  if (workspaceDir) {
    try {
      await commitWorkspaceState(
        workspaceDir,
        buildUpgradeCommitMessage({
          action: "upgrade",
          phase: "starting",
          from: entry.serviceGroupVersion ?? "unknown",
          to: versionTag,
          topology: "docker",
          assistantId: entry.assistantId,
        }),
      );
    } catch (err) {
      console.warn(
        `⚠️  Failed to create pre-upgrade workspace commit: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log("💾 Capturing existing container environment...");
  const capturedEnv = await captureContainerEnv(res.assistantContainer);
  console.log(
    `   Captured ${Object.keys(capturedEnv).length} env var(s) from ${res.assistantContainer}\n`,
  );

  // Notify connected clients that an upgrade is about to begin.
  // This must fire BEFORE any progress broadcasts so the UI sets
  // isUpdateInProgress = true and starts displaying status messages.
  console.log("📢 Notifying connected clients...");
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildStartingEvent(versionTag),
  );
  // Brief pause to allow SSE delivery before progress events.
  await new Promise((r) => setTimeout(r, 500));

  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.DOWNLOADING),
  );
  console.log("📦 Pulling new Docker images...");
  const pullImages: Array<[string, string]> = [
    ["assistant", imageTags.assistant],
    ["gateway", imageTags.gateway],
    ["credential-executor", imageTags["credential-executor"]],
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
      buildCompleteEvent(entry.serviceGroupVersion ?? "unknown", false),
    );
    emitCliError("IMAGE_PULL_FAILED", "Failed to pull Docker images", detail);
    process.exit(1);
  }
  console.log("✅ Docker images pulled\n");

  // Parse gateway port from entry's runtimeUrl, fall back to default
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

  // Extract CES_SERVICE_TOKEN from the captured env so it can be passed via
  // the dedicated cesServiceToken parameter (which propagates it to all three
  // containers). If the old instance predates CES_SERVICE_TOKEN, generate a
  // fresh one so gateway and CES can authenticate.
  const cesServiceToken =
    capturedEnv["CES_SERVICE_TOKEN"] || randomBytes(32).toString("hex");

  // Retrieve or generate a bootstrap secret for the gateway. The secret was
  // persisted to disk during hatch; older instances won't have one yet.
  // This runs BEFORE stopping containers so a write failure (disk full,
  // permissions) doesn't leave the assistant offline.
  const loadedSecret = loadBootstrapSecret(instanceName);
  const bootstrapSecret = loadedSecret || randomBytes(32).toString("hex");
  if (!loadedSecret) {
    saveBootstrapSecret(instanceName, bootstrapSecret);
  }

  // Extract or generate the shared JWT signing key. Pre-env-var instances
  // won't have it in capturedEnv, so generate fresh in that case.
  const signingKey =
    capturedEnv["ACTOR_TOKEN_SIGNING_KEY"] || randomBytes(32).toString("hex");

  // Create pre-upgrade backup (best-effort, daemon must be running)
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.BACKING_UP),
  );
  console.log("📦 Creating pre-upgrade backup...");
  const backupPath = await createBackup(entry.runtimeUrl, entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before ${entry.serviceGroupVersion ?? "unknown"} → ${versionTag}`,
  });
  if (backupPath) {
    console.log(`   Backup saved: ${backupPath}\n`);
    // Clean up old pre-upgrade backups, keep last 3
    pruneOldBackups(entry.assistantId, 3);
  } else {
    console.warn("⚠️  Pre-upgrade backup failed (continuing with upgrade)\n");
  }

  // Persist the backup path so `vellum rollback` can restore the exact backup
  // created for this upgrade attempt — never a stale backup from a prior cycle.
  // Re-read the entry to pick up the rollback state saved earlier.
  {
    const current = findAssistantByName(entry.assistantId);
    if (current) {
      saveAssistantEntry({
        ...current,
        preUpgradeBackupPath: backupPath ?? undefined,
      });
    }
  }

  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.INSTALLING),
  );

  // If we have the target version's migration ceiling, run a PRECISE
  // rollback on the CURRENT (newer) daemon before stopping it. The current
  // daemon has the `down()` code for all migrations it applied, so it can
  // cleanly revert to the target version's ceiling. This is critical for
  // multi-version downgrades where the old daemon wouldn't know about
  // migrations introduced after its release.
  let preSwapRollbackOk = true;
  if (
    isDowngrade &&
    (targetMigrationCeiling.dbVersion !== undefined ||
      targetMigrationCeiling.workspaceMigrationId !== undefined)
  ) {
    console.log("🔄 Reverting database changes for downgrade...");
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

  console.log("🛑 Stopping existing containers...");
  await stopContainers(res);
  console.log("✅ Containers stopped\n");

  // Build the set of extra env vars to replay on the new assistant container.
  // Captured env vars serve as the base; keys already managed by
  // serviceDockerRunArgs are excluded to avoid duplicates.
  const envKeysSetByRunArgs = new Set(CONTAINER_ENV_EXCLUDE_KEYS);
  // Only exclude keys that serviceDockerRunArgs will actually set
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

  console.log("🔄 Migrating security files to gateway volume...");
  await migrateGatewaySecurityFiles(res, (msg) => console.log(msg));

  console.log("🔄 Migrating credential files to CES security volume...");
  await migrateCesSecurityFiles(res, (msg) => console.log(msg));

  console.log("🚀 Starting upgraded containers...");
  await startContainers(
    {
      signingKey,
      bootstrapSecret,
      cesServiceToken,
      extraAssistantEnv,
      gatewayPort,
      imageTags,
      instanceName,
      res,
    },
    (msg) => console.log(msg),
  );
  console.log("✅ Containers started\n");

  console.log("Waiting for assistant to become ready...");
  const ready = await waitForReady(entry.runtimeUrl);
  if (ready) {
    // Update lockfile with new service group topology
    const newDigests = await captureImageRefs(res);
    const updatedEntry: AssistantEntry = {
      ...entry,
      serviceGroupVersion: versionTag,
      containerInfo: {
        assistantImage: imageTags.assistant,
        gatewayImage: imageTags.gateway,
        cesImage: imageTags["credential-executor"],
        assistantDigest: newDigests?.assistant,
        gatewayDigest: newDigests?.gateway,
        cesDigest: newDigests?.["credential-executor"],
        networkName: res.network,
      },
      previousServiceGroupVersion: entry.serviceGroupVersion,
      previousContainerInfo: entry.containerInfo,
      previousDbMigrationVersion: preMigrationState.dbVersion,
      previousWorkspaceMigrationId: preMigrationState.lastWorkspaceMigrationId,
      // Preserve the backup path so `vellum rollback` can restore it later
      preUpgradeBackupPath: backupPath ?? undefined,
    };
    saveAssistantEntry(updatedEntry);

    // After a downgrade, fall back to asking the now-running old daemon
    // to roll back migrations above its own registry ceiling when either:
    // (a) no release metadata was available for a precise pre-swap rollback, or
    // (b) the precise pre-swap rollback failed (timeout, daemon crash, etc.).
    // This is a no-op for multi-version jumps where the old daemon doesn't
    // know about the newer migrations, but correct for single-step rollbacks.
    if (
      isDowngrade &&
      (!preSwapRollbackOk ||
        (targetMigrationCeiling.dbVersion === undefined &&
          targetMigrationCeiling.workspaceMigrationId === undefined))
    ) {
      await rollbackMigrations(
        entry.runtimeUrl,
        entry.assistantId,
        undefined,
        undefined,
        true,
      );
    }

    // Notify clients on the new service group that the upgrade succeeded.
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(versionTag, true),
    );

    // Record successful upgrade in workspace git history
    if (workspaceDir) {
      try {
        await commitWorkspaceState(
          workspaceDir,
          buildUpgradeCommitMessage({
            action: "upgrade",
            phase: "complete",
            from: entry.serviceGroupVersion ?? "unknown",
            to: versionTag,
            topology: "docker",
            assistantId: entry.assistantId,
            result: "success",
          }),
        );
      } catch (err) {
        console.warn(
          `⚠️  Failed to create post-upgrade workspace commit: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(
      `\n✅ Docker assistant '${instanceName}' upgraded to ${versionTag}.`,
    );
  } else {
    console.error(`\n❌ Containers failed to become ready within the timeout.`);

    if (previousImageRefs) {
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildProgressEvent(UPGRADE_PROGRESS.REVERTING),
      );
      console.log(`\n🔄 Rolling back to previous images...`);
      try {
        // Attempt to roll back migrations before swapping containers.
        // The new daemon may be partially up — try best-effort.
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
            bootstrapSecret,
            cesServiceToken,
            extraAssistantEnv,
            gatewayPort,
            imageTags: previousImageRefs,
            instanceName,
            res,
          },
          (msg) => console.log(msg),
        );

        const rollbackReady = await waitForReady(entry.runtimeUrl);
        if (rollbackReady) {
          // Restore data from the backup created for THIS upgrade attempt.
          // Only use the specific backupPath — never scan for the latest
          // backup on disk, which could be from a previous upgrade cycle
          // and contain stale data.
          if (backupPath) {
            await broadcastUpgradeEvent(
              entry.runtimeUrl,
              entry.assistantId,
              buildProgressEvent(UPGRADE_PROGRESS.RESTORING),
            );
            console.log(`📦 Restoring data from pre-upgrade backup...`);
            console.log(`   Source: ${backupPath}`);
            const restored = await restoreBackup(
              entry.runtimeUrl,
              entry.assistantId,
              backupPath,
            );
            if (restored) {
              console.log("   ✅ Data restored successfully\n");
            } else {
              console.warn(
                "   ⚠️  Data restore failed (rollback continues without data restoration)\n",
              );
            }
          } else {
            console.log(
              "ℹ️  No pre-upgrade backup was created for this attempt, skipping data restoration\n",
            );
          }

          // Capture fresh digests from the now-running rolled-back containers.
          const rollbackDigests = await captureImageRefs(res);

          // Restore previous container info in lockfile after rollback.
          // The *Image fields hold human-readable image:tag names from the
          // pre-upgrade containerInfo; *Digest fields get fresh values from
          // the running containers (or fall back to previousImageRefs).
          const rolledBackEntry: AssistantEntry = {
            ...entry,
            containerInfo: {
              assistantImage:
                entry.containerInfo?.assistantImage ??
                previousImageRefs.assistant,
              gatewayImage:
                entry.containerInfo?.gatewayImage ?? previousImageRefs.gateway,
              cesImage:
                entry.containerInfo?.cesImage ??
                previousImageRefs["credential-executor"],
              assistantDigest:
                rollbackDigests?.assistant ?? previousImageRefs.assistant,
              gatewayDigest:
                rollbackDigests?.gateway ?? previousImageRefs.gateway,
              cesDigest:
                rollbackDigests?.["credential-executor"] ??
                previousImageRefs["credential-executor"],
              networkName: res.network,
            },
            previousServiceGroupVersion: undefined,
            previousContainerInfo: undefined,
            previousDbMigrationVersion: undefined,
            previousWorkspaceMigrationId: undefined,
            // Clear the backup path — the upgrade that created it just failed
            preUpgradeBackupPath: undefined,
          };
          saveAssistantEntry(rolledBackEntry);

          // Notify clients that the upgrade failed and rolled back.
          await broadcastUpgradeEvent(
            entry.runtimeUrl,
            entry.assistantId,
            buildCompleteEvent(
              entry.serviceGroupVersion ?? "unknown",
              false,
              entry.serviceGroupVersion,
            ),
          );

          console.log(
            `\n⚠️  Rolled back to previous version. Upgrade to ${versionTag} failed.`,
          );
          emitCliError(
            "READINESS_TIMEOUT",
            `Upgrade to ${versionTag} failed: containers did not become ready. Rolled back to previous version.`,
          );
        } else {
          console.error(
            `\n❌ Rollback also failed. Manual intervention required.`,
          );
          console.log(
            `   Check logs with: docker logs -f ${res.assistantContainer}`,
          );
          await broadcastUpgradeEvent(
            entry.runtimeUrl,
            entry.assistantId,
            buildCompleteEvent(entry.serviceGroupVersion ?? "unknown", false),
          );
          emitCliError(
            "ROLLBACK_FAILED",
            "Rollback also failed after readiness timeout. Manual intervention required.",
          );
        }
      } catch (rollbackErr) {
        const rollbackDetail =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        console.error(`\n❌ Rollback failed: ${rollbackDetail}`);
        console.error(`   Manual intervention required.`);
        console.log(
          `   Check logs with: docker logs -f ${res.assistantContainer}`,
        );
        await broadcastUpgradeEvent(
          entry.runtimeUrl,
          entry.assistantId,
          buildCompleteEvent(entry.serviceGroupVersion ?? "unknown", false),
        );
        emitCliError(
          "ROLLBACK_FAILED",
          "Auto-rollback failed after readiness timeout. Manual intervention required.",
          rollbackDetail,
        );
      }
    } else {
      console.log(`   No previous images available for rollback.`);
      console.log(
        `   Check logs with: docker logs -f ${res.assistantContainer}`,
      );
      await broadcastUpgradeEvent(
        entry.runtimeUrl,
        entry.assistantId,
        buildCompleteEvent(entry.serviceGroupVersion ?? "unknown", false),
      );
      emitCliError(
        "ROLLBACK_NO_STATE",
        "Containers failed to become ready and no previous images available for rollback.",
      );
    }

    process.exit(1);
  }
}

interface UpgradeApiResponse {
  detail: string;
  version: string | null;
}

async function upgradePlatform(
  entry: AssistantEntry,
  version: string | null,
): Promise<void> {
  const workspaceDir = entry.resources
    ? join(entry.resources.instanceDir, ".vellum", "workspace")
    : null;

  // Record version transition start in workspace git history
  if (workspaceDir) {
    try {
      await commitWorkspaceState(
        workspaceDir,
        buildUpgradeCommitMessage({
          action: "upgrade",
          phase: "starting",
          from: entry.serviceGroupVersion ?? "unknown",
          to: version ?? "latest",
          topology: "managed",
          assistantId: entry.assistantId,
        }),
      );
    } catch (err) {
      console.warn(
        `⚠️  Failed to create pre-upgrade workspace commit: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `🔄 Upgrading platform-hosted assistant '${entry.assistantId}'...\n`,
  );

  const token = readPlatformToken();
  if (!token) {
    const msg =
      "Error: Not logged in. Run `vellum login --token <token>` first.";
    console.error(msg);
    emitCliError("AUTH_FAILED", msg);
    process.exit(1);
  }

  const orgId = await fetchOrganizationId(token);

  const url = `${getPlatformUrl()}/v1/assistants/upgrade/`;
  const body: { assistant_id?: string; version?: string } = {
    assistant_id: entry.assistantId,
  };
  if (version) {
    body.version = version;
  }

  // Notify connected clients that an upgrade is about to begin.
  const targetVersion = version ?? `v${cliPkg.version}`;
  console.log("📢 Notifying connected clients...");
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildStartingEvent(targetVersion, 90),
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token,
      "Vellum-Organization-Id": orgId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `Error: Platform upgrade failed (${response.status}): ${text}`,
    );
    emitCliError(
      "PLATFORM_API_ERROR",
      `Platform upgrade failed (${response.status})`,
      text,
    );
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(entry.serviceGroupVersion ?? "unknown", false),
    );
    process.exit(1);
  }

  const result = (await response.json()) as UpgradeApiResponse;

  // NOTE: We intentionally do NOT broadcast a "complete" event here.
  // The platform API returning 200 only means "upgrade request accepted" —
  // the service group has not yet restarted with the new version.  The
  // completion signal will come from the client's health-check
  // version-change detection (DaemonConnection.swift) once the new
  // version actually appears after the platform restarts the service group.

  // Record successful upgrade in workspace git history
  if (workspaceDir) {
    try {
      await commitWorkspaceState(
        workspaceDir,
        buildUpgradeCommitMessage({
          action: "upgrade",
          phase: "complete",
          from: entry.serviceGroupVersion ?? "unknown",
          to: version ?? "latest",
          topology: "managed",
          assistantId: entry.assistantId,
          result: "success",
        }),
      );
    } catch (err) {
      console.warn(
        `⚠️  Failed to create post-upgrade workspace commit: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`✅ ${result.detail}`);
  if (result.version) {
    console.log(`   Version: ${result.version}`);
  }
}

export async function upgrade(): Promise<void> {
  const { name, version } = parseArgs();
  const entry = resolveTargetAssistant(name);
  const cloud = resolveCloud(entry);

  try {
    if (cloud === "docker") {
      await upgradeDocker(entry, version);
      return;
    }

    if (cloud === "vellum") {
      await upgradePlatform(entry, version);
      return;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Upgrade failed: ${detail}`);
    // Best-effort: notify connected clients that the upgrade failed.
    // A `starting` event may have been sent inside upgradeDocker/upgradePlatform
    // before the error was thrown, so we must close with `complete`.
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(entry.serviceGroupVersion ?? "unknown", false),
    );
    emitCliError(categorizeUpgradeError(err), "Upgrade failed", detail);
    process.exit(1);
  }

  const msg = `Error: Upgrade is not supported for '${cloud}' assistants. Only 'docker' and 'vellum' assistants can be upgraded via the CLI.`;
  console.error(msg);
  emitCliError("UNSUPPORTED_TOPOLOGY", msg);
  process.exit(1);
}

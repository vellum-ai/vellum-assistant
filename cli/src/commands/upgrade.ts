import { randomBytes } from "crypto";

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
  commitWorkspaceViaGateway,
  CONTAINER_ENV_EXCLUDE_KEYS,
  rollbackMigrations,
  UPGRADE_PROGRESS,
  waitForReady,
} from "../lib/upgrade-lifecycle.js";
import { parseVersion } from "../lib/version-compat.js";

interface UpgradeArgs {
  name: string | null;
  version: string | null;
  prepare: boolean;
  finalize: boolean;
}

function parseArgs(): UpgradeArgs {
  const args = process.argv.slice(3);
  let name: string | null = null;
  let version: string | null = null;
  let prepare = false;
  let finalize = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum upgrade [<name>] [options]");
      console.log("");
      console.log("Upgrade an assistant to a newer version.");
      console.log("To roll back to a previous version, use `vellum rollback`.");
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
      console.log(
        "  --prepare            Run pre-upgrade steps only (backup, notify) without swapping versions",
      );
      console.log(
        "  --finalize           Run post-upgrade steps only (broadcast complete, workspace commit)",
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
    } else if (arg === "--prepare") {
      prepare = true;
    } else if (arg === "--finalize") {
      finalize = true;
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
      emitCliError("UNKNOWN", `Unknown option '${arg}'`);
      process.exit(1);
    }
  }

  if (prepare && finalize) {
    console.error("Error: --prepare and --finalize are mutually exclusive.");
    emitCliError("UNKNOWN", "--prepare and --finalize are mutually exclusive");
    process.exit(1);
  }

  return { name, version, prepare, finalize };
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

  const versionTag =
    version ?? (cliPkg.version ? `v${cliPkg.version}` : "latest");

  // Reject downgrades — `vellum upgrade` only handles forward version changes.
  // Users should use `vellum rollback --version <version>` for downgrades.
  const currentVersion = entry.serviceGroupVersion;
  if (currentVersion && versionTag) {
    const current = parseVersion(currentVersion);
    const target = parseVersion(versionTag);
    if (current && target) {
      const isOlder =
        target.major < current.major ||
        (target.major === current.major && target.minor < current.minor) ||
        (target.major === current.major &&
          target.minor === current.minor &&
          target.patch < current.patch);
      if (isOlder) {
        const msg = `Cannot upgrade to an older version (${versionTag} < ${currentVersion}). Use \`vellum rollback --version ${versionTag}\` instead.`;
        console.error(msg);
        emitCliError("VERSION_DIRECTION", msg);
        process.exit(1);
      }
    }
  }

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
  try {
    await commitWorkspaceViaGateway(
      entry.runtimeUrl,
      entry.assistantId,
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

    // Notify clients on the new service group that the upgrade succeeded.
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(versionTag, true),
    );

    // Record successful upgrade in workspace git history
    try {
      await commitWorkspaceViaGateway(
        entry.runtimeUrl,
        entry.assistantId,
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
  // Reject downgrades — `vellum upgrade` only handles forward version changes.
  // Users should use `vellum rollback --version <version>` for downgrades.
  // Only enforce this guard when the user explicitly passed `--version`.
  // When version is null the platform API decides the actual target, so
  // we must not block the request based on the local CLI version.
  const currentVersion = entry.serviceGroupVersion;
  if (version && currentVersion) {
    const current = parseVersion(currentVersion);
    const target = parseVersion(version);
    if (current && target) {
      const isOlder =
        target.major < current.major ||
        (target.major === current.major && target.minor < current.minor) ||
        (target.major === current.major &&
          target.minor === current.minor &&
          target.patch < current.patch);
      if (isOlder) {
        const msg = `Cannot upgrade to an older version (${version} < ${currentVersion}). Use \`vellum rollback --version ${version}\` instead.`;
        console.error(msg);
        emitCliError("VERSION_DIRECTION", msg);
        process.exit(1);
      }
    }
  }

  // Record version transition start in workspace git history
  try {
    await commitWorkspaceViaGateway(
      entry.runtimeUrl,
      entry.assistantId,
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
  try {
    await commitWorkspaceViaGateway(
      entry.runtimeUrl,
      entry.assistantId,
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

  console.log(`✅ ${result.detail}`);
  if (result.version) {
    console.log(`   Version: ${result.version}`);
  }
}

/**
 * Pre-upgrade steps for Sparkle (macOS app) lifecycle.
 * Runs the pre-update orchestration without actually swapping containers:
 * broadcasts SSE events, creates a workspace commit, creates a backup,
 * prunes old backups, and outputs the backup path.
 */
async function upgradePrepare(
  entry: AssistantEntry,
  version: string | null,
): Promise<void> {
  const targetVersion = version ?? entry.serviceGroupVersion ?? "unknown";
  const currentVersion = entry.serviceGroupVersion ?? "unknown";

  // 1. Broadcast "starting" so the UI shows the progress spinner
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildStartingEvent(targetVersion, 30),
  );

  // 2. Workspace commit: record pre-update state
  try {
    await commitWorkspaceViaGateway(
      entry.runtimeUrl,
      entry.assistantId,
      `[sparkle-update] Starting: ${currentVersion} → ${targetVersion}`,
    );
  } catch (err) {
    console.warn(
      `⚠️  Failed to create pre-upgrade workspace commit: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. Progress: saving backup
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildProgressEvent("Saving a backup of your data…"),
  );

  // 4. Create backup
  const backupPath = await createBackup(entry.runtimeUrl, entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before ${currentVersion} → ${targetVersion}`,
  });

  // 5. Prune old backups (keep 3)
  if (backupPath) {
    pruneOldBackups(entry.assistantId, 3);
  }

  // 6. Progress: installing update
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildProgressEvent(UPGRADE_PROGRESS.INSTALLING),
  );

  // 7. Output backup path to stdout for the macOS app to parse
  if (backupPath) {
    console.log(`BACKUP_PATH:${backupPath}`);
  }
}

/**
 * Post-upgrade steps for Sparkle (macOS app) lifecycle.
 * Called after the app has been replaced and the daemon is back up.
 * Broadcasts a "complete" SSE event and creates a workspace commit.
 */
async function upgradeFinalize(
  entry: AssistantEntry,
  version: string | null,
): Promise<void> {
  if (!version) {
    console.error(
      "Error: --finalize requires --version <from-version> to record the transition.",
    );
    emitCliError(
      "UNKNOWN",
      "--finalize requires --version <from-version> to record the transition",
    );
    process.exit(1);
  }

  const fromVersion = version;
  const currentVersion = cliPkg.version
    ? `v${cliPkg.version}`
    : (entry.serviceGroupVersion ?? "unknown");

  // 1. Broadcast "complete" so the UI clears the progress spinner
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildCompleteEvent(currentVersion, true),
  );

  // 2. Workspace commit: record successful update
  try {
    await commitWorkspaceViaGateway(
      entry.runtimeUrl,
      entry.assistantId,
      `[sparkle-update] Complete: ${fromVersion} → ${currentVersion}\n\nresult: success`,
    );
  } catch (err) {
    console.warn(
      `⚠️  Failed to create post-upgrade workspace commit: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function upgrade(): Promise<void> {
  const { name, version, prepare, finalize } = parseArgs();
  const entry = resolveTargetAssistant(name);

  if (prepare) {
    await upgradePrepare(entry, version);
    return;
  }

  if (finalize) {
    await upgradeFinalize(entry, version);
    return;
  }

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

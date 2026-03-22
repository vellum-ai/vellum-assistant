import { randomBytes } from "crypto";
import { join } from "path";

import {
  findAssistantByName,
  getActiveAssistant,
  loadAllAssistants,
  saveAssistantEntry,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import {
  captureImageRefs,
  clearSigningKeyBootstrapLock,
  GATEWAY_INTERNAL_PORT,
  dockerResourceNames,
  migrateCesSecurityFiles,
  migrateGatewaySecurityFiles,
  startContainers,
  stopContainers,
} from "../lib/docker";
import type { ServiceName } from "../lib/docker";
import {
  loadBootstrapSecret,
  saveBootstrapSecret,
} from "../lib/guardian-token";
import {
  findLatestPreUpgradeBackup,
  restoreBackup,
} from "../lib/backup-ops.js";
import { emitCliError, categorizeUpgradeError } from "../lib/cli-error.js";
import {
  broadcastUpgradeEvent,
  captureContainerEnv,
  waitForReady,
} from "../lib/upgrade-lifecycle.js";
import { commitWorkspaceState } from "../lib/workspace-git.js";

function parseArgs(): { name: string | null } {
  const args = process.argv.slice(3);
  let name: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum rollback [<name>]");
      console.log("");
      console.log("Roll back a Docker assistant to the previous version.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>  Name of the assistant to roll back (default: active or only assistant)",
      );
      console.log("");
      console.log("Examples:");
      console.log(
        "  vellum rollback                # Roll back the active assistant",
      );
      console.log(
        "  vellum rollback my-assistant   # Roll back a specific assistant by name",
      );
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
      emitCliError("UNKNOWN", `Unknown option '${arg}'`);
      process.exit(1);
    }
  }

  return { name };
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
 * Resolve which assistant to target for the rollback command. Priority:
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

export async function rollback(): Promise<void> {
  const { name } = parseArgs();
  const entry = resolveTargetAssistant(name);
  const cloud = resolveCloud(entry);

  // Only Docker assistants support rollback
  if (cloud !== "docker") {
    const msg =
      "Rollback is only supported for Docker assistants. For managed assistants, use the version picker to upgrade to the previous version.";
    console.error(msg);
    emitCliError("UNSUPPORTED_TOPOLOGY", msg);
    process.exit(1);
  }

  // Verify rollback state exists
  if (!entry.previousServiceGroupVersion || !entry.previousContainerInfo) {
    const msg =
      "No rollback state available. Run `vellum upgrade` first to create a rollback point.";
    console.error(msg);
    emitCliError("ROLLBACK_NO_STATE", msg);
    process.exit(1);
  }

  // Verify all three digest fields are present
  const prev = entry.previousContainerInfo;
  if (!prev.assistantDigest || !prev.gatewayDigest || !prev.cesDigest) {
    const msg =
      "Incomplete rollback state. Previous container digests are missing.";
    console.error(msg);
    emitCliError("ROLLBACK_NO_STATE", msg);
    process.exit(1);
  }

  // Build image refs from the previous digests
  const previousImageRefs: Record<ServiceName, string> = {
    assistant: prev.assistantDigest,
    "credential-executor": prev.cesDigest,
    gateway: prev.gatewayDigest,
  };

  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);

  try {
    const workspaceDir = entry.resources
      ? join(entry.resources.instanceDir, ".vellum", "workspace")
      : undefined;

    // Record rollback start in workspace git history
    if (workspaceDir) {
      try {
        await commitWorkspaceState(
          workspaceDir,
          `[rollback] Starting: ${entry.serviceGroupVersion ?? "unknown"} → ${entry.previousServiceGroupVersion ?? "unknown"}\n\n` +
            `assistant: ${entry.assistantId}\n` +
            `from: ${entry.serviceGroupVersion ?? "unknown"}\n` +
            `to: ${entry.previousServiceGroupVersion ?? "unknown"}\n` +
            `topology: docker`,
        );
      } catch (err) {
        console.warn(
          `⚠️  Failed to create pre-rollback workspace commit: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(
      `🔄 Rolling back Docker assistant '${instanceName}' to ${entry.previousServiceGroupVersion}...\n`,
    );

    // Capture current container env
    console.log("💾 Capturing existing container environment...");
    const capturedEnv = await captureContainerEnv(res.assistantContainer);
    console.log(
      `   Captured ${Object.keys(capturedEnv).length} env var(s) from ${res.assistantContainer}\n`,
    );

    // Extract CES_SERVICE_TOKEN from captured env, or generate fresh one
    const cesServiceToken =
      capturedEnv["CES_SERVICE_TOKEN"] || randomBytes(32).toString("hex");

    // Retrieve or generate a bootstrap secret for the gateway.
    const loadedSecret = loadBootstrapSecret(instanceName);
    const bootstrapSecret = loadedSecret || randomBytes(32).toString("hex");
    if (!loadedSecret) {
      saveBootstrapSecret(instanceName, bootstrapSecret);
    }

    // Build extra env vars, excluding keys managed by serviceDockerRunArgs
    const envKeysSetByRunArgs = new Set([
      "CES_SERVICE_TOKEN",
      "VELLUM_ASSISTANT_NAME",
      "RUNTIME_HTTP_HOST",
      "PATH",
    ]);
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

    // Notify connected clients that a rollback is about to begin (best-effort)
    console.log("📢 Notifying connected clients...");
    await broadcastUpgradeEvent(entry.runtimeUrl, entry.assistantId, {
      type: "starting",
      targetVersion: entry.previousServiceGroupVersion,
      expectedDowntimeSeconds: 60,
    });
    // Brief pause to allow SSE delivery before containers stop.
    await new Promise((r) => setTimeout(r, 500));

    console.log("🛑 Stopping existing containers...");
    await stopContainers(res);
    console.log("✅ Containers stopped\n");

    // Run security file migrations and signing key cleanup
    console.log("🔄 Migrating security files to gateway volume...");
    await migrateGatewaySecurityFiles(res, (msg) => console.log(msg));

    console.log("🔄 Migrating credential files to CES security volume...");
    await migrateCesSecurityFiles(res, (msg) => console.log(msg));

    console.log("🔑 Clearing signing key bootstrap lock...");
    try {
      await clearSigningKeyBootstrapLock(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `⚠️  Failed to clear signing key bootstrap lock (${message}), continuing...`,
      );
    }

    console.log("🚀 Starting containers with previous version...");
    await startContainers(
      {
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
    console.log("✅ Containers started\n");

    console.log("Waiting for assistant to become ready...");
    const ready = await waitForReady(entry.runtimeUrl);

    if (ready) {
      // Restore data from pre-upgrade backup if available
      const latestBackup = findLatestPreUpgradeBackup(entry.assistantId);
      if (latestBackup) {
        console.log(`📦 Restoring data from pre-upgrade backup...`);
        console.log(`   Source: ${latestBackup}`);
        const restored = await restoreBackup(
          entry.runtimeUrl,
          entry.assistantId,
          latestBackup,
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
          "ℹ️  No pre-upgrade backup found, skipping data restoration\n",
        );
      }

      // Capture new digests from the rolled-back containers
      const newDigests = await captureImageRefs(res);

      // Swap current/previous state to enable "rollback the rollback"
      const updatedEntry: AssistantEntry = {
        ...entry,
        serviceGroupVersion: entry.previousServiceGroupVersion,
        containerInfo: {
          assistantImage: prev.assistantImage ?? previousImageRefs.assistant,
          gatewayImage: prev.gatewayImage ?? previousImageRefs.gateway,
          cesImage: prev.cesImage ?? previousImageRefs["credential-executor"],
          assistantDigest: newDigests?.assistant,
          gatewayDigest: newDigests?.gateway,
          cesDigest: newDigests?.["credential-executor"],
          networkName: res.network,
        },
        previousServiceGroupVersion: entry.serviceGroupVersion,
        previousContainerInfo: entry.containerInfo,
      };
      saveAssistantEntry(updatedEntry);

      // Notify clients that the rollback succeeded
      await broadcastUpgradeEvent(entry.runtimeUrl, entry.assistantId, {
        type: "complete",
        installedVersion: entry.previousServiceGroupVersion,
        success: true,
      });

      // Record successful rollback in workspace git history
      if (workspaceDir) {
        try {
          await commitWorkspaceState(
            workspaceDir,
            `[rollback] Complete: ${entry.serviceGroupVersion ?? "unknown"} → ${entry.previousServiceGroupVersion ?? "unknown"}\n\n` +
              `assistant: ${entry.assistantId}\n` +
              `from: ${entry.serviceGroupVersion ?? "unknown"}\n` +
              `to: ${entry.previousServiceGroupVersion ?? "unknown"}\n` +
              `result: success\n` +
              `topology: docker`,
          );
        } catch (err) {
          console.warn(
            `⚠️  Failed to create post-rollback workspace commit: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      console.log(
        `\n✅ Docker assistant '${instanceName}' rolled back to ${entry.previousServiceGroupVersion}.`,
      );
    } else {
      console.error(
        `\n❌ Containers failed to become ready within the timeout.`,
      );
      console.log(
        `   Check logs with: docker logs -f ${res.assistantContainer}`,
      );
      emitCliError(
        "READINESS_TIMEOUT",
        "Rolled-back containers failed to become ready within the timeout.",
      );
      process.exit(1);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Rollback failed: ${detail}`);
    emitCliError(categorizeUpgradeError(err), "Rollback failed", detail);
    process.exit(1);
  }
}

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
  clearSigningKeyBootstrapLock,
  DOCKER_READY_TIMEOUT_MS,
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
import { loadBootstrapSecret, saveBootstrapSecret, loadGuardianToken } from "../lib/guardian-token";
import { exec, execOutput } from "../lib/step-runner";

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
        process.exit(1);
      }
      version = next;
      i++;
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
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
    console.error("No assistants found. Run 'vellum hatch' first.");
  } else {
    console.error(
      "Multiple assistants found. Specify a name or set an active assistant with 'vellum use <name>'.",
    );
  }
  process.exit(1);
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

async function upgradeDocker(
  entry: AssistantEntry,
  version: string | null,
): Promise<void> {
  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);

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

  // Persist rollback state to lockfile BEFORE any destructive changes.
  // This enables the `vellum rollback` command to restore the previous version.
  if (entry.serviceGroupVersion && entry.containerInfo) {
    const rollbackEntry: AssistantEntry = {
      ...entry,
      previousServiceGroupVersion: entry.serviceGroupVersion,
      previousContainerInfo: { ...entry.containerInfo },
    };
    saveAssistantEntry(rollbackEntry);
    console.log(`   Saved rollback state: ${entry.serviceGroupVersion}\n`);
  }

  console.log("💾 Capturing existing container environment...");
  const capturedEnv = await captureContainerEnv(res.assistantContainer);
  console.log(
    `   Captured ${Object.keys(capturedEnv).length} env var(s) from ${res.assistantContainer}\n`,
  );

  console.log("📦 Pulling new Docker images...");
  await exec("docker", ["pull", imageTags.assistant]);
  await exec("docker", ["pull", imageTags.gateway]);
  await exec("docker", ["pull", imageTags["credential-executor"]]);
  console.log("✅ Docker images pulled\n");

  // Notify connected clients that an upgrade is about to begin.
  console.log("📢 Notifying connected clients...");
  await broadcastUpgradeEvent(entry.runtimeUrl, entry.assistantId, {
    type: "starting",
    targetVersion: versionTag,
    expectedDowntimeSeconds: 60,
  });
  // Brief pause to allow SSE delivery before containers stop.
  await new Promise((r) => setTimeout(r, 500));

  console.log("🛑 Stopping existing containers...");
  await stopContainers(res);
  console.log("✅ Containers stopped\n");

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
  const loadedSecret = loadBootstrapSecret(instanceName);
  const bootstrapSecret = loadedSecret || randomBytes(32).toString("hex");
  if (!loadedSecret) {
    saveBootstrapSecret(instanceName, bootstrapSecret);
  }

  // Build the set of extra env vars to replay on the new assistant container.
  // Captured env vars serve as the base; keys already managed by
  // serviceDockerRunArgs are excluded to avoid duplicates.
  const envKeysSetByRunArgs = new Set([
    "CES_SERVICE_TOKEN",
    "VELLUM_ASSISTANT_NAME",
    "RUNTIME_HTTP_HOST",
    "PATH",
  ]);
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

  console.log("🔑 Clearing signing key bootstrap lock...");
  try {
    await clearSigningKeyBootstrapLock(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠️  Failed to clear signing key bootstrap lock (${message}), continuing...`,
    );
  }

  console.log("🚀 Starting upgraded containers...");
  await startContainers(
    {
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
    };
    saveAssistantEntry(updatedEntry);

    // Notify clients on the new service group that the upgrade succeeded.
    await broadcastUpgradeEvent(entry.runtimeUrl, entry.assistantId, {
      type: "complete",
      installedVersion: versionTag,
      success: true,
    });

    console.log(
      `\n✅ Docker assistant '${instanceName}' upgraded to ${versionTag}.`,
    );
  } else {
    console.error(`\n❌ Containers failed to become ready within the timeout.`);

    if (previousImageRefs) {
      console.log(`\n🔄 Rolling back to previous images...`);
      try {
        await stopContainers(res);

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

        const rollbackReady = await waitForReady(entry.runtimeUrl);
        if (rollbackReady) {
          // Restore previous container info in lockfile after rollback.
          // previousImageRefs contains sha256 digests from `docker inspect
          // --format {{.Image}}`.  The *Image fields should hold
          // human-readable image:tag names, so prefer the pre-upgrade
          // containerInfo values and store digests in the *Digest fields.
          if (previousImageRefs) {
            const rolledBackEntry: AssistantEntry = {
              ...entry,
              containerInfo: {
                assistantImage:
                  entry.containerInfo?.assistantImage ??
                  previousImageRefs.assistant,
                gatewayImage:
                  entry.containerInfo?.gatewayImage ??
                  previousImageRefs.gateway,
                cesImage:
                  entry.containerInfo?.cesImage ??
                  previousImageRefs["credential-executor"],
                assistantDigest: previousImageRefs.assistant,
                gatewayDigest: previousImageRefs.gateway,
                cesDigest: previousImageRefs["credential-executor"],
                networkName: res.network,
              },
              previousServiceGroupVersion: undefined,
              previousContainerInfo: undefined,
            };
            saveAssistantEntry(rolledBackEntry);
          }

          // Notify clients that the upgrade failed and rolled back.
          await broadcastUpgradeEvent(entry.runtimeUrl, entry.assistantId, {
            type: "complete",
            installedVersion: entry.serviceGroupVersion ?? "unknown",
            success: false,
            rolledBackToVersion: entry.serviceGroupVersion,
          });

          console.log(
            `\n⚠️  Rolled back to previous version. Upgrade to ${versionTag} failed.`,
          );
        } else {
          console.error(
            `\n❌ Rollback also failed. Manual intervention required.`,
          );
          console.log(
            `   Check logs with: docker logs -f ${res.assistantContainer}`,
          );
        }
      } catch (rollbackErr) {
        console.error(
          `\n❌ Rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        );
        console.error(`   Manual intervention required.`);
        console.log(
          `   Check logs with: docker logs -f ${res.assistantContainer}`,
        );
      }
    } else {
      console.log(`   No previous images available for rollback.`);
      console.log(
        `   Check logs with: docker logs -f ${res.assistantContainer}`,
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
  console.log(
    `🔄 Upgrading platform-hosted assistant '${entry.assistantId}'...\n`,
  );

  const token = readPlatformToken();
  if (!token) {
    console.error(
      "Error: Not logged in. Run `vellum login --token <token>` first.",
    );
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
  await broadcastUpgradeEvent(entry.runtimeUrl, entry.assistantId, {
    type: "starting",
    targetVersion,
    expectedDowntimeSeconds: 90,
  });

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
    await broadcastUpgradeEvent(entry.runtimeUrl, entry.assistantId, {
      type: "complete",
      installedVersion: entry.serviceGroupVersion ?? "unknown",
      success: false,
    });
    process.exit(1);
  }

  const result = (await response.json()) as UpgradeApiResponse;

  // NOTE: We intentionally do NOT broadcast a "complete" event here.
  // The platform API returning 200 only means "upgrade request accepted" —
  // the service group has not yet restarted with the new version.  The
  // completion signal will come from the client's health-check
  // version-change detection (DaemonConnection.swift) once the new
  // version actually appears after the platform restarts the service group.

  console.log(`✅ ${result.detail}`);
  if (result.version) {
    console.log(`   Version: ${result.version}`);
  }
}

export async function upgrade(): Promise<void> {
  const { name, version } = parseArgs();
  const entry = resolveTargetAssistant(name);
  const cloud = resolveCloud(entry);

  if (cloud === "docker") {
    await upgradeDocker(entry, version);
    return;
  }

  if (cloud === "vellum") {
    await upgradePlatform(entry, version);
    return;
  }

  console.error(
    `Error: Upgrade is not supported for '${cloud}' assistants. Only 'docker' and 'vellum' assistants can be upgraded via the CLI.`,
  );
  process.exit(1);
}

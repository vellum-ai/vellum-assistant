import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { getDaemonPidPath, saveAssistantEntry } from "./assistant-config.js";
import type { AssistantEntry } from "./assistant-config.js";
import { seedGuardianTokenFromSiblingEnv } from "./guardian-token.js";
import {
  generateLocalSigningKey,
  isAssistantWatchModeAvailable,
  isGatewayWatchModeAvailable,
  startLocalDaemon,
  startGateway,
} from "./local.js";
import { maybeStartNgrokTunnel } from "./ngrok.js";
import {
  isProcessAlive,
  resolveProcessState,
  stopProcessByPidFile,
} from "./process.js";

export const ACTIVE_CALL_LEASES_FILE = "active-call-leases.json";

export type ActiveCallLease = {
  callSessionId: string;
};

export function getAssistantRootDir(entry: AssistantEntry): string {
  if (!entry.resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  return join(entry.resources.instanceDir, ".vellum");
}

export function readActiveCallLeases(vellumDir: string): ActiveCallLease[] {
  const path = join(vellumDir, ACTIVE_CALL_LEASES_FILE);
  if (!existsSync(path)) {
    return [];
  }

  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    version?: number;
    leases?: Array<{ callSessionId?: unknown }>;
  };
  if (raw.version !== 1 || !Array.isArray(raw.leases)) {
    throw new Error(`Invalid active call lease file at ${path}`);
  }

  return raw.leases.filter(
    (lease): lease is ActiveCallLease =>
      typeof lease?.callSessionId === "string" &&
      lease.callSessionId.length > 0,
  );
}

/**
 * Return the call session IDs of active phone-call keepalive leases that
 * should block a sleep, or `[]` when the daemon isn't running. Propagates
 * `readActiveCallLeases`'s "Invalid active call lease file" error — callers
 * decide how to present it.
 */
export function getBlockingCallLeases(entry: AssistantEntry): string[] {
  const vellumDir = getAssistantRootDir(entry);
  if (!isProcessAlive(getDaemonPidPath(entry.resources)).alive) {
    return [];
  }
  return readActiveCallLeases(vellumDir).map((lease) => lease.callSessionId);
}

/**
 * Stop a local assistant's daemon and gateway processes. Throws when active
 * phone-call leases block the sleep (unless `force`) or when the entry is
 * missing resource configuration.
 */
export async function sleepLocalAssistant(
  entry: AssistantEntry,
  opts: { force: boolean },
): Promise<void> {
  const vellumDir = getAssistantRootDir(entry);
  const assistantPidFile = getDaemonPidPath(entry.resources);
  const gatewayPidFile = join(vellumDir, "gateway.pid");

  if (!opts.force) {
    let activeIds: string[];
    try {
      activeIds = getBlockingCallLeases(entry);
    } catch (err) {
      throw new Error(
        `${
          err instanceof Error ? err.message : String(err)
        }. Use 'vellum sleep --force' to override if you want to stop the assistant anyway.`,
      );
    }
    if (activeIds.length > 0) {
      throw new Error(
        `assistant is staying awake for active phone calls (${activeIds.join(
          ", ",
        )}). Use 'vellum sleep --force' to stop it anyway.`,
      );
    }
  }

  const assistantStopped = await stopProcessByPidFile(
    assistantPidFile,
    "assistant",
  );
  if (!assistantStopped) {
    console.log("Assistant is not running.");
  } else {
    console.log("Assistant stopped.");
  }

  // Stop gateway — use a longer timeout because the gateway has a configurable
  // drain window (5s) before it exits.
  const gatewayStopped = await stopProcessByPidFile(
    gatewayPidFile,
    "gateway",
    undefined,
    7000,
  );
  if (!gatewayStopped) {
    console.log("Gateway is not running.");
  } else {
    console.log("Gateway stopped.");
  }
}

/**
 * Start a local assistant's daemon and gateway processes (plus the optional
 * ngrok tunnel). Throws when the entry is missing resource configuration.
 */
export async function wakeLocalAssistant(
  entry: AssistantEntry,
  opts: { watch: boolean; foreground: boolean },
): Promise<void> {
  const { watch, foreground } = opts;
  const resources = entry.resources;
  if (!resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }

  const pidFile = getDaemonPidPath(resources);

  let daemonRunning = false;
  const daemonState = await resolveProcessState(
    pidFile,
    resources.daemonPort,
    "Assistant",
  );
  if (daemonState.status === "healthy") {
    if (watch && isAssistantWatchModeAvailable()) {
      console.log(
        `Assistant running (pid ${daemonState.pid}) — restarting in watch mode...`,
      );
      await stopProcessByPidFile(pidFile, "assistant");
    } else {
      daemonRunning = true;
      if (watch) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) — watch mode not available (no source files). Keeping existing process.`,
        );
      } else {
        console.log(`Assistant already running (pid ${daemonState.pid}).`);
      }
    }
  }

  // Resolve the signing key. The gateway persists its own copy to disk at
  // <instanceDir>/.vellum/protected/actor-token-signing-key. That on-disk key
  // is the source of truth because it is what the gateway actually used to sign
  // existing actor tokens. Prefer it over the lockfile value so that tokens
  // survive upgrades and any scenario where the two diverge.
  //
  // NOTE: Removal of this legacy key path read is blocked on removing all use
  // of the signing key from the assistant daemon. Until then, the on-disk key
  // must remain the authoritative source.
  const legacyKeyPath = join(
    resources.instanceDir,
    ".vellum",
    "protected",
    "actor-token-signing-key",
  );
  let signingKey: string | undefined;
  if (existsSync(legacyKeyPath)) {
    try {
      const raw = readFileSync(legacyKeyPath);
      if (raw.length === 32) {
        signingKey = raw.toString("hex");
      }
    } catch {
      // Ignore — fall through to lockfile or generate.
    }
  }
  if (!signingKey) {
    signingKey = resources.signingKey ?? generateLocalSigningKey();
  }
  if (signingKey !== resources.signingKey) {
    entry.resources = { ...resources, signingKey };
    saveAssistantEntry(entry);
  }

  let bootstrapSecret = entry.guardianBootstrapSecret;
  let bootstrapSecretBackfilled = false;
  if (!bootstrapSecret) {
    bootstrapSecret = generateLocalSigningKey();
    entry.guardianBootstrapSecret = bootstrapSecret;
    saveAssistantEntry(entry);
    bootstrapSecretBackfilled = true;
  }

  if (!daemonRunning) {
    await startLocalDaemon(watch, resources, { foreground, signingKey });
  }

  // Start gateway
  {
    const vellumDir = join(resources.instanceDir, ".vellum");
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    const gatewayState = await resolveProcessState(
      gatewayPidFile,
      resources.gatewayPort,
      "Gateway",
    );
    const gatewayAlive = gatewayState.status === "healthy";
    const needsRestart = bootstrapSecretBackfilled && gatewayAlive;
    if (needsRestart) {
      const restartWithWatch = watch && isGatewayWatchModeAvailable();
      if (restartWithWatch) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting to apply bootstrap secret...`,
        );
      } else {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting without watch mode to apply bootstrap secret...`,
        );
      }
      await stopProcessByPidFile(gatewayPidFile, "gateway");
      await startGateway(restartWithWatch, resources, {
        signingKey,
        bootstrapSecret,
      });
    } else if (gatewayAlive) {
      if (watch && isGatewayWatchModeAvailable()) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting in watch mode...`,
        );
        await stopProcessByPidFile(gatewayPidFile, "gateway");
        await startGateway(watch, resources, { signingKey, bootstrapSecret });
      } else {
        if (watch) {
          console.log(
            `Gateway running (pid ${gatewayState.pid}) — watch mode not available (no source files). Keeping existing process.`,
          );
        } else {
          console.log(`Gateway already running (pid ${gatewayState.pid}).`);
        }
      }
    } else {
      await startGateway(watch, resources, { signingKey, bootstrapSecret });
    }
  }

  // Self-heal the guardian token when the current environment's config dir
  // is missing it. Hatch cross-writes the lockfile across env dirs but the
  // guardian token is only persisted under the hatch-time env, so a desktop
  // app built under a different VELLUM_ENVIRONMENT can't find a bearer and
  // cascades into 401 → auth-rate-limit → 429. A sibling env copy is cheap
  // and strictly additive.
  if (seedGuardianTokenFromSiblingEnv(entry.assistantId)) {
    console.log("   Seeded guardian token from sibling environment.");
  }

  // Auto-start ngrok if webhook integrations (e.g. Telegram) are configured.
  const workspaceDir = join(resources.instanceDir, ".vellum", "workspace");
  const ngrokChild = await maybeStartNgrokTunnel(
    resources.gatewayPort,
    workspaceDir,
  );
  if (ngrokChild?.pid) {
    const ngrokPidFile = join(resources.instanceDir, ".vellum", "ngrok.pid");
    writeFileSync(ngrokPidFile, String(ngrokChild.pid));
  }

  console.log("Wake complete.");

  if (foreground) {
    console.log("Running in foreground (Ctrl+C to stop)...\n");
    // Block forever — the daemon is running with inherited stdio so its
    // output streams to this terminal. When the user hits Ctrl+C, SIGINT
    // propagates to the daemon child and both exit.
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        resolve();
      });
      process.on("SIGTERM", () => resolve());
    });
  }
}

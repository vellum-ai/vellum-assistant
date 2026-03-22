import { DOCKER_READY_TIMEOUT_MS } from "./docker.js";
import { loadGuardianToken } from "./guardian-token.js";
import { execOutput } from "./step-runner.js";

// ---------------------------------------------------------------------------
// Shared constants & builders for upgrade / rollback lifecycle events
// ---------------------------------------------------------------------------

/** User-facing progress messages shared across upgrade and rollback flows. */
export const UPGRADE_PROGRESS = {
  DOWNLOADING: "Downloading the update…",
  BACKING_UP: "Saving a backup of your data…",
  INSTALLING: "Installing the update…",
  REVERTING: "The update didn't work. Reverting to the previous version…",
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

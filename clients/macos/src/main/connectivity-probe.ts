import { app, BrowserWindow, net, powerMonitor } from "electron";

import { getLockfileData } from "@vellumai/local-mode";
import {
  getLoopbackGatewayPort,
  isLoopbackGatewayCloud,
  isUsableRuntimeUrl,
  resolveCloud,
} from "@vellumai/local-mode/contract";

import { setBackendReachable } from "./status";

const PROBE_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

let probeTimer: ReturnType<typeof setInterval> | null = null;
let probing = false;

/**
 * The outcome of trying to resolve a probe target from the lockfile.
 *
 * - `"local"`: the active assistant runs its gateway on a loopback port
 *   of this machine; the caller should fetch the returned URL and set
 *   reachability from the response.
 * - `"paired"`: the active assistant is a remote instance paired from
 *   another machine; the caller should fetch its tunnel `/healthz` and set
 *   reachability from the response.
 * - `"non-local"`: the active assistant is cloud-hosted or self-hosted
 *   remote; there is no local gateway to probe, and any prior
 *   `backendReachable = false` from a stale local-assistant entry should
 *   be cleared. Non-local assistant health is tracked separately via the
 *   platform's operational-status polling.
 * - `"unreachable"`: the active entry is paired but its runtimeUrl is
 *   unusable, so there is nothing to probe and the tunnel cannot be
 *   reached. The caller should report unreachable.
 * - `"unknown"`: the lockfile could not be read, there is no active
 *   assistant, or the active entry is a local runtime without a gateway
 *   port. The caller should not change the reachability state, because
 *   it cannot prove either direction.
 */
type ProbeTarget =
  | { kind: "local"; url: string }
  | { kind: "paired"; url: string }
  | { kind: "non-local" }
  | { kind: "unreachable" }
  | { kind: "unknown" };

function resolveProbeTarget(lockfilePaths: string[]): ProbeTarget {
  const result = getLockfileData(lockfilePaths);
  if (!result.ok) return { kind: "unknown" };
  const { assistants, activeAssistant } = result.data;
  if (!activeAssistant) return { kind: "unknown" };
  const entry = assistants.find((a) => a.assistantId === activeAssistant);
  if (!entry) return { kind: "unknown" };
  // Cloud wins over resources: merges can leave a stale gatewayPort on a
  // non-local entry, and it must not be loopback-probed.
  if (!isLoopbackGatewayCloud(entry.cloud)) {
    if (resolveCloud(entry) === "paired") {
      const { runtimeUrl } = entry;
      if (typeof runtimeUrl !== "string" || !isUsableRuntimeUrl(runtimeUrl)) {
        return { kind: "unreachable" };
      }
      return {
        kind: "paired",
        url: `${runtimeUrl.replace(/\/+$/, "")}/healthz`,
      };
    }
    return { kind: "non-local" };
  }
  const port = getLoopbackGatewayPort(entry);
  if (port) {
    return {
      kind: "local",
      url: `http://127.0.0.1:${port}/healthz`,
    };
  }
  return { kind: "unknown" };
}

async function runProbeOnce(lockfilePaths: string[]): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    const target = resolveProbeTarget(lockfilePaths);
    if (target.kind === "unknown") return;
    if (target.kind === "non-local") {
      setBackendReachable(true);
      return;
    }
    if (target.kind === "unreachable") {
      setBackendReachable(false);
      return;
    }
    // Paired runtimeUrls are commonly ngrok tunnels; free-tier ngrok answers
    // browser User-Agents with an interstitial unless this header is present
    // (mirrors sanitizePairedForwardHeaders in local-mode's gateway-proxy).
    const headers =
      target.kind === "paired"
        ? { "ngrok-skip-browser-warning": "true" }
        : undefined;
    const ok = await net
      .fetch(target.url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      .then((r) => r.ok)
      .catch(() => false);
    setBackendReachable(ok);
  } finally {
    probing = false;
  }
}

function hasVisibleWindow(): boolean {
  return BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.isVisible(),
  );
}

function startProbing(lockfilePaths: string[]): void {
  if (probeTimer) return;
  void runProbeOnce(lockfilePaths);
  probeTimer = setInterval(
    () => void runProbeOnce(lockfilePaths),
    PROBE_INTERVAL_MS,
  );
}

function stopProbing(): void {
  if (!probeTimer) return;
  clearInterval(probeTimer);
  probeTimer = null;
}

export function installConnectivityProbe(
  lockfilePaths: string[],
): () => Promise<void> {
  // Returns the probe's promise so the manual-retry IPC handler can await
  // completion before reporting the post-probe state back to the renderer.
  const runProbe = () => runProbeOnce(lockfilePaths);

  powerMonitor.on("suspend", stopProbing);
  powerMonitor.on("resume", () => startProbing(lockfilePaths));

  app.on("browser-window-focus", () => {
    if (!probeTimer) startProbing(lockfilePaths);
  });

  app.on("browser-window-blur", () => {
    if (!hasVisibleWindow()) stopProbing();
  });

  startProbing(lockfilePaths);
  return runProbe;
}

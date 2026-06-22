import { app, BrowserWindow, net, powerMonitor } from "electron";

import { getLockfileData } from "@vellumai/local-mode";

import { setBackendReachable } from "./status";

const PROBE_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

let probeTimer: ReturnType<typeof setInterval> | null = null;
let probing = false;

function resolveProbeTarget(lockfilePaths: string[]): string | null {
  const result = getLockfileData(lockfilePaths);
  if (!result.ok) return null;
  const { assistants, activeAssistant } = result.data;
  if (!activeAssistant) return null;
  const entry = assistants.find((a) => a.assistantId === activeAssistant);
  if (!entry?.resources?.gatewayPort) return null;
  return `http://127.0.0.1:${entry.resources.gatewayPort}/healthz`;
}

async function runProbeOnce(lockfilePaths: string[]): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    const target = resolveProbeTarget(lockfilePaths);
    if (!target) return;
    const ok = await net
      .fetch(target, {
        method: "GET",
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

#!/usr/bin/env bun
/**
 * Probe-and-dispatch shim for `bun run dev`.
 *
 * Decides whether `vel up` is running by probing its edge proxy at
 * http://localhost:3000 (the URL Swift Vellum hits today; see
 * `cli/commands/up.ts::ensureEdgeProxyRunning` in the Vellum platform
 * repo) and dispatches accordingly:
 *
 *   - vel up detected → `bun run dev:electron-only` with
 *     `VELLUM_DEV_URL=http://localhost:3000`. The renderer attaches to
 *     the running stack and the BrowserWindow loads the edge proxy URL,
 *     so backend calls work the same way they do for the Swift app.
 *   - no vel up        → `bun run dev:standalone`. Spawns our own Vite
 *     on :5173 plus Electron. No backends, but the shell — menus, IPC
 *     bridge, window chrome, settings — is fully exercisable.
 *
 * This is intentionally NOT a process supervisor — it's a single
 * routing decision that delegates to scripts that already use
 * concurrently for the actual orchestration.
 */
import { spawn } from "node:child_process";

const VEL_EDGE_PROXY_URL = "http://localhost:3000";
const PROBE_TIMEOUT_MS = 1_500;

async function isVelUp(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(VEL_EDGE_PROXY_URL, { signal: controller.signal });
    // Any non-5xx response counts — even a 404 means something is
    // listening on that port and serving HTTP, which is enough signal
    // that we're not running cold.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const velRunning = await isVelUp();
const downstreamScript = velRunning ? "dev:electron-only" : "dev:standalone";
const env: NodeJS.ProcessEnv = velRunning
  ? { ...process.env, VELLUM_DEV_URL: VEL_EDGE_PROXY_URL }
  : process.env;

if (velRunning) {
  console.log(
    `[dev] detected vel up at ${VEL_EDGE_PROXY_URL} — attaching Electron`,
  );
} else {
  console.log(
    `[dev] no vel up at ${VEL_EDGE_PROXY_URL} — running standalone (Vite :5173, no backends)`,
  );
}

const child = spawn("bun", ["run", downstreamScript], {
  stdio: "inherit",
  env,
});
child.once("error", (err) => {
  console.error(`[dev] failed to spawn ${downstreamScript}:`, err);
  process.exit(1);
});
child.once("exit", (code) => {
  process.exit(code ?? 0);
});

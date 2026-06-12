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
 *     `VELLUM_DEV_URL=http://localhost:3000/assistant`. The renderer
 *     attaches to the running stack and the BrowserWindow loads the
 *     edge proxy at the `/assistant` path (the bare root is the
 *     marketing site), so backend calls work the same way they do for
 *     the Swift app.
 *   - no vel up        → `bun run dev:standalone`. Spawns our own Vite
 *     on :5173 plus Electron. No backends, but the shell — menus, IPC
 *     bridge, window chrome, settings — is fully exercisable.
 *
 * This is intentionally NOT a process supervisor — it's a single
 * routing decision that delegates to scripts that already use
 * concurrently for the actual orchestration.
 */
import { spawn } from "node:child_process";

// Edge-proxy origin used by the probe — vel up serves the marketing site
// at the bare root and reverse-proxies `/assistant/*` to apps/web's Vite,
// so we probe the origin and load `/assistant` (the renderer path) when
// attaching. apps/web's `vite.config.ts` declares `base: "/assistant/"`,
// which is the same path Swift Vellum hits today.
const VEL_EDGE_PROXY_ORIGIN = "http://localhost:3000";
const VEL_RENDERER_URL = `${VEL_EDGE_PROXY_ORIGIN}/assistant`;
const PROBE_TIMEOUT_MS = 1_500;

async function isVelUp(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(VEL_EDGE_PROXY_ORIGIN, {
      signal: controller.signal,
    });
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

// Match the native Swift app's default of "local".
const env: NodeJS.ProcessEnv = {
  ...process.env,
  VELLUM_ENVIRONMENT: process.env.VELLUM_ENVIRONMENT || "local",
  ...(velRunning ? { VELLUM_DEV_URL: VEL_RENDERER_URL } : {}),
};

if (velRunning) {
  console.log(
    `[dev] detected vel up at ${VEL_EDGE_PROXY_ORIGIN} — attaching Electron to ${VEL_RENDERER_URL} (env: ${env.VELLUM_ENVIRONMENT})`,
  );
} else {
  console.log(
    `[dev] no vel up at ${VEL_EDGE_PROXY_ORIGIN} — running standalone (Vite :5173, no backends)`,
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

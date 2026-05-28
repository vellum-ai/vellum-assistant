#!/usr/bin/env bun
/**
 * One-command dev launcher for the Electron app. Spawns the apps/web Vite
 * dev server, waits for it to come up, then runs `electron-vite dev` so
 * the BrowserWindow opens against a hot-reloading renderer.
 *
 * Without this, running the Electron app required two terminals (one for
 * apps/web's dev server, one for electron-vite). This is the script that
 * `vel up --electron` will end up calling once that integration lands.
 *
 * Either child exiting non-zero — or the renderer never coming up — tears
 * the whole stack down so we don't leave a zombie Vite server behind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DEV_SERVER_PORT, DEV_SERVER_URL } from "../src/shared/dev-server";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MACOS_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(MACOS_ROOT, "..", "..");
const WEB_ROOT = path.resolve(REPO_ROOT, "apps", "web");

const RENDERER_TIMEOUT_MS = 30_000;
const RENDERER_POLL_INTERVAL_MS = 250;
const SHUTDOWN_GRACE_MS = 2_000;

interface Proc {
  name: string;
  child: ChildProcess;
}

const procs: Proc[] = [];
let shuttingDown = false;

/**
 * Spawn a child with prefixed stdout/stderr and register it with the
 * tracked procs list. The optional `env` is merged onto `process.env` so
 * callers only specify overrides.
 *
 * Any child exiting while we're not already shutting down triggers a
 * coordinated teardown.
 */
function start(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  console.log(`[dev] spawning ${name}: ${command} ${args.join(" ")} (cwd=${cwd})`);
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stdout?.on("data", (b: Buffer) =>
    process.stdout.write(`[${name}] ${b}`),
  );
  child.stderr?.on("data", (b: Buffer) =>
    process.stderr.write(`[${name}] ${b}`),
  );
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev] ${name} exited (code=${code ?? "null"} signal=${signal ?? "null"}) — tearing down`,
    );
    shutdown(code ?? 1);
  });
  procs.push({ name, child });
  return child;
}

/**
 * Coordinated teardown. Sends SIGTERM to anything still running, then
 * escalates to SIGKILL after the grace window so a stuck child can't
 * keep the launcher alive. `child.killed` only tracks whether a signal
 * was *sent*, not whether the child has exited, so we check
 * `exitCode === null` to determine "still running" instead.
 */
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of procs) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const { child } of procs) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/**
 * Poll the renderer URL until it responds or we exceed the timeout.
 * Returns early if a coordinated shutdown is already in progress — that
 * happens when the spawned Vite child exited before serving anything,
 * and continuing to poll would just delay the inevitable exit.
 */
async function waitForRenderer(): Promise<void> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (shuttingDown) {
      throw new Error("aborted: shutting down before renderer came up");
    }
    try {
      const res = await fetch(DEV_SERVER_URL);
      if (res.ok || res.status === 304) return;
    } catch {
      // Connection refused while Vite boots — keep polling.
    }
    await sleep(RENDERER_POLL_INTERVAL_MS);
  }
  throw new Error(
    `renderer never responded at ${DEV_SERVER_URL} after ${RENDERER_TIMEOUT_MS}ms`,
  );
}

async function main(): Promise<void> {
  // Port resolution in apps/web's vite.config.ts is:
  //   const env = { ...process.env, ...loadEnv(mode, cwd, "") }
  //   server.port = parseInt(env.PORT || "3000")
  // — i.e. .env files WIN over the spawn env. Passing `--port` as a Vite
  // CLI flag is the only way to override `apps/web/.env` if a developer
  // has set `PORT` there. The `PORT` env var is kept as a belt-and-
  // suspenders signal for any tooling downstream that reads it.
  start(
    "web",
    "bun",
    ["run", "dev", "--", "--port", DEV_SERVER_PORT],
    WEB_ROOT,
    { PORT: DEV_SERVER_PORT },
  );
  console.log(`[dev] waiting for renderer at ${DEV_SERVER_URL}...`);
  try {
    await waitForRenderer();
  } catch (err) {
    console.error(`[dev] ${err instanceof Error ? err.message : String(err)}`);
    shutdown(1);
    return;
  }
  console.log("[dev] renderer up — launching Electron");
  start("electron", "bunx", ["electron-vite", "dev"], MACOS_ROOT);
}

await main();

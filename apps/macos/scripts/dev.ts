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
 * `detached: true` puts the child in its own process group via `setsid(2)`
 * so we can signal the whole subtree at teardown — `bun run dev` /
 * `bunx electron-vite dev` are wrapper processes; the real Vite and
 * Electron processes are descendants that would otherwise survive when we
 * SIGTERM only the wrapper (Bun's `run.noOrphans` would handle this too,
 * but it's a bunfig.toml setting we don't control from here).
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
    detached: true,
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
 * Send a signal to a child's entire process group (negative pid). The
 * child was spawned with `detached: true`, so `process.kill(-pid, ...)`
 * reaches every descendant — Vite/Electron sitting under the `bun run` /
 * `bunx` wrapper. Falls back to signalling the leader directly if the
 * group is already gone (ESRCH).
 *
 * No-op if the child already exited.
 */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
      // Ignore — race between exit and signal.
    }
  }
}

/**
 * Coordinated teardown. Sends SIGTERM to every child's process group,
 * then escalates to SIGKILL after the grace window so a stuck descendant
 * can't keep the launcher alive.
 *
 * Sets `process.exitCode` *before* unref'ing the escalation timer: once
 * the kills go out and the child exits, the only ref'd handle keeping
 * the event loop alive may be gone, and Node will exit naturally. If
 * `exitCode` weren't set first, that natural exit would report `0` and
 * make a failed startup look like success to `vel up --electron`.
 */
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  for (const { child } of procs) {
    signalProcessGroup(child, "SIGTERM");
  }
  setTimeout(() => {
    for (const { child } of procs) {
      signalProcessGroup(child, "SIGKILL");
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

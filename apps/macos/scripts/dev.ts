#!/usr/bin/env bun
/**
 * One-command dev launcher for the Electron app. Spawns the apps/web Vite
 * dev server, waits for it to come up on http://localhost:5173, then runs
 * `electron-vite dev` so the BrowserWindow opens against a hot-reloading
 * renderer.
 *
 * Without this, running the Electron app required two terminals (one for
 * apps/web's dev server, one for electron-vite). This is the script that
 * `vel up --electron` will end up calling once that integration lands.
 *
 * Either child exiting non-zero brings the whole stack down so we don't
 * leave a zombie Vite server behind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MACOS_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(MACOS_ROOT, "..", "..");
const WEB_ROOT = path.resolve(REPO_ROOT, "apps", "web");
const RENDERER_URL = "http://localhost:5173";
const RENDERER_TIMEOUT_MS = 30_000;

interface Proc {
  name: string;
  child: ChildProcess;
}

const procs: Proc[] = [];
let shuttingDown = false;

function start(
  name: string,
  command: string,
  args: string[],
  cwd: string,
): ChildProcess {
  console.log(`[dev] spawning ${name}: ${command} ${args.join(" ")} (cwd=${cwd})`);
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
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

function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of procs) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Hard escalation if a child ignores SIGTERM.
  setTimeout(() => {
    for (const { child } of procs) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 2_000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForRenderer(): Promise<void> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RENDERER_URL);
      if (res.ok || res.status === 304) return;
    } catch {
      // Connection refused while Vite boots — keep polling.
    }
    await sleep(250);
  }
  throw new Error(
    `Renderer never responded at ${RENDERER_URL} after ${RENDERER_TIMEOUT_MS}ms`,
  );
}

start("web", "bun", ["run", "dev"], WEB_ROOT);
console.log(`[dev] waiting for renderer at ${RENDERER_URL}...`);
await waitForRenderer();
console.log("[dev] renderer up — launching Electron");
start("electron", "bunx", ["electron-vite", "dev"], MACOS_ROOT);

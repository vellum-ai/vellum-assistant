#!/usr/bin/env bun
/**
 * Wait for the standalone web dev server (Vite on :5173) to answer, then exit
 * 0 — a drop-in for `wait-on http://localhost:5173`, with a diagnostic tail
 * for hung Vite startups.
 *
 * Vite startup can wedge indefinitely before it binds the port, and the
 * teardown that follows this script's failure exit is what un-wedges it:
 * `concurrently --kill-others` SIGTERMs the web half, Vite completes startup
 * while dying, and its log reads "ready in <≈ the timeout>". The hang
 * therefore leaves no trace of where it was stuck unless that trace is
 * captured from the outside, before teardown. On timeout this script writes
 * that capture to /tmp: a wall-clock stack sample (`sample`) of each Vite
 * process on the dev port, the port's listener state, and a reachability
 * probe taken after polling has stopped.
 *
 * Best-effort by design: capture failures are logged and the script still
 * exits 1, so the dev orchestration behaves exactly as it did with `wait-on`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DEFAULT_URL = "http://localhost:5173";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;
const SAMPLE_SECONDS = 2;
const MAX_SAMPLED_PROCESSES = 4;

const args = process.argv.slice(2);
let timeoutMs = DEFAULT_TIMEOUT_MS;
let url = DEFAULT_URL;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--timeout") {
    const value = Number(args[++i]);
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`[dev] invalid --timeout value: ${args[i]}`);
      process.exit(2);
    }
    timeoutMs = value;
  } else {
    url = args[i]!;
  }
}
const port = Number(new URL(url).port || "80");

async function isUp(target: string, probeTimeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    // Any non-5xx response counts — even a 404 means the server is up and
    // serving HTTP (Vite answers the bare root with a base-URL hint page).
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Run a command and capture stdout, with a hard timeout so a wedged
 * diagnostic tool can't hang the diagnostics. */
function run(cmd: string, argv: string[], commandTimeoutMs = 20_000): string {
  return execFileSync(cmd, argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: commandTimeoutMs,
  });
}

/** Every process whose command names `vite` and carries `--port <port>` —
 * catches both the `bun --bun vite` wrapper and the node Vite it spawns,
 * while excluding `electron-vite` (different port) and shell wrappers. */
function viteProcessesOnPort(targetPort: number): Array<{ pid: number; command: string }> {
  let psOut: string;
  try {
    psOut = run("ps", ["ax", "-o", "pid=,command="]);
  } catch {
    return [];
  }
  const procs: Array<{ pid: number; command: string }> = [];
  for (const line of psOut.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2]!;
    if (pid === process.pid) {
      continue;
    }
    if (/\bvite\b/.test(command) && command.includes(`--port ${targetPort}`)) {
      procs.push({ pid, command });
    }
  }
  return procs;
}

/** Wall-clock stack sample of a process via macOS `sample` — shows the exact
 * frames a stuck process is blocked in. */
function sampleProcess(pid: number): string {
  const sampleFile = `/tmp/vellum-dev-vite-hang-sample-${pid}.txt`;
  try {
    run("sample", [String(pid), String(SAMPLE_SECONDS), "-mayDie", "-file", sampleFile]);
    const text = fs.readFileSync(sampleFile, "utf8");
    fs.rmSync(sampleFile, { force: true });
    return text;
  } catch (err) {
    return `sample failed for PID ${pid}: ${(err as Error).message}\n`;
  }
}

async function captureHangDiagnostics(): Promise<string> {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const reportPath = `/tmp/vellum-dev-vite-hang-${stamp}.txt`;
  const sections: string[] = [
    `Vite dev-server hang capture — ${new Date().toISOString()}`,
    `Waited ${timeoutMs}ms for ${url} with no response.`,
  ];

  const procs = viteProcessesOnPort(port);
  if (procs.length > 0) {
    sections.push(
      `Vite processes on port ${port}:\n${procs.map((p) => `  ${p.pid}  ${p.command}`).join("\n")}`,
    );
  } else {
    sections.push(`No Vite processes matching --port ${port} found in ps output.`);
  }

  try {
    sections.push(`lsof -nP -iTCP:${port}:\n${run("lsof", ["-nP", `-iTCP:${port}`])}`);
  } catch {
    sections.push(`lsof -nP -iTCP:${port}: no sockets (nothing bound or listening).`);
  }

  for (const proc of procs.slice(0, MAX_SAMPLED_PROCESSES)) {
    sections.push(`===== sample of PID ${proc.pid} (${proc.command}) =====\n${sampleProcess(proc.pid)}`);
  }

  // Polling stopped when the wait deadline passed; a server that answers here
  // but never answered during the wait implicates the polling itself.
  const reachable = await isUp(url, 1_000);
  sections.push(
    `Reachability probe after polling stopped and samples were taken: ${reachable ? "SERVER ANSWERED" : "still unreachable"}.`,
  );

  fs.writeFileSync(reportPath, `${sections.join("\n\n")}\n`);
  return reportPath;
}

const deadline = Date.now() + timeoutMs;
let up = false;
while (Date.now() < deadline) {
  if (await isUp(url, PROBE_TIMEOUT_MS)) {
    up = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

if (up) {
  process.exit(0);
}

console.error(
  `[dev] timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${url} — capturing hang diagnostics before exiting.`,
);
try {
  const reportPath = await captureHangDiagnostics();
  console.error(`[dev] wrote hang diagnostics (stack samples + port state) to:`);
  console.error(`[dev]   ${reportPath}`);
  console.error(`[dev] attach that file when investigating the Vite startup hang.`);
} catch (err) {
  console.error(`[dev] hang diagnostics capture failed: ${(err as Error).message}`);
}
process.exit(1);

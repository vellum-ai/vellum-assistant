/**
 * Host bash executor — runs shell commands on the host machine and posts
 * results back to the daemon via the host proxy poster.
 *
 * Supports timeout (SIGTERM → SIGKILL cascade) and cancellation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

import type { HostProxyExecutor } from "../host-proxy-router";
import type { HostProxySseMessage } from "../host-proxy-sse";
import type { HostProxyPoster } from "../host-proxy-poster";
import log from "../logger";

const DEFAULT_TIMEOUT_SECONDS = 120;
const SIGKILL_GRACE_MS = 2_000;

interface RunningProcess {
  child: ChildProcess;
  cancelled: boolean;
  hasExited: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
}

const runningProcesses = new Map<string, RunningProcess>();

function handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
  const requestId = message.requestId as string | undefined;
  if (!requestId) {
    log.warn("[host-bash-executor] message missing requestId");
    return;
  }

  const command = message.command as string | undefined;
  if (!command) {
    void poster.postBashResult({ requestId, stdout: "", stderr: "Missing command", exitCode: 1, timedOut: false });
    return;
  }

  const workingDir = (message.working_dir as string | undefined) || homedir();
  const timeoutSeconds = (message.timeout_seconds as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS;
  const extraEnv = (message.env as Record<string, string> | undefined) ?? {};

  const env = { ...process.env, ...extraEnv };

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn("/bin/bash", ["-c", "--", command], {
    cwd: workingDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry: RunningProcess = { child, cancelled: false, hasExited: false, killTimer: null };
  runningProcesses.set(requestId, entry);

  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  // Timeout cascade: SIGTERM, then SIGKILL after grace period
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");

    entry.killTimer = setTimeout(() => {
      if (!entry.hasExited) {
        child.kill("SIGKILL");
      }
    }, SIGKILL_GRACE_MS);
  }, timeoutSeconds * 1_000);

  child.on("close", (exitCode) => {
    entry.hasExited = true;
    clearTimeout(timeoutTimer);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    runningProcesses.delete(requestId);

    if (entry.cancelled) return;

    void poster.postBashResult({
      requestId,
      stdout,
      stderr,
      exitCode,
      timedOut,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timeoutTimer);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    runningProcesses.delete(requestId);

    if (entry.cancelled) return;

    void poster.postBashResult({
      requestId,
      stdout,
      stderr: stderr || err.message,
      exitCode: 1,
      timedOut: false,
    });
  });
}

function handleCancel(message: HostProxySseMessage, _poster: HostProxyPoster): void {
  const requestId = message.requestId as string | undefined;
  if (!requestId) return;

  const entry = runningProcesses.get(requestId);
  if (!entry) return;

  entry.cancelled = true;
  entry.child.kill("SIGTERM");

  entry.killTimer = setTimeout(() => {
    if (!entry.hasExited) {
      entry.child.kill("SIGKILL");
    }
  }, SIGKILL_GRACE_MS);
}

export const hostBashExecutor: HostProxyExecutor = { handleRequest, handleCancel };

// Test seam
export const __testing = {
  get runningProcesses() { return runningProcesses; },
};

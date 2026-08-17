/**
 * Host shell executor. Runs `host_bash` command strings on the host machine
 * and posts results back to the daemon via the host proxy poster.
 *
 * The wire contract (request and result shapes) is shared; the shell binary
 * and argument shape are injected per client, so macOS runs Bash while
 * Windows runs PowerShell, with no implicit fallback between shells.
 *
 * Supports timeout (SIGTERM → SIGKILL cascade) and cancellation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

import type { HostProxyExecutor } from "../router";
import type { HostProxySseMessage } from "../sse";
import type { HostProxyPoster } from "../poster";
import log from "./logger";

const DEFAULT_TIMEOUT_SECONDS = 120;
const SIGKILL_GRACE_MS = 2_000;

/** How a client's shell runs one wire-contract command string. */
export interface HostShellSpec {
  buildSpawn(command: string): { file: string; args: string[] };
}

interface RunningProcess {
  child: ChildProcess;
  cancelled: boolean;
  hasExited: boolean;
  /** A result has been posted; a spawn failure fires both error and close. */
  settled: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
}

const runningProcesses = new Map<string, RunningProcess>();

function handleRequest(
  spec: HostShellSpec,
  message: HostProxySseMessage,
  poster: HostProxyPoster,
): void {
  const requestId = message.requestId as string | undefined;
  if (!requestId) {
    log.warn("[host-shell-executor] message missing requestId");
    return;
  }

  const command = message.command as string | undefined;
  if (!command) {
    void poster.postBashResult({
      requestId,
      stdout: "",
      stderr: "Missing command",
      exitCode: 1,
      timedOut: false,
    });
    return;
  }

  const workingDir = (message.working_dir as string | undefined) || homedir();
  const timeoutSeconds =
    (message.timeout_seconds as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS;
  const extraEnv = (message.env as Record<string, string> | undefined) ?? {};

  const env = { ...process.env, ...extraEnv };

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const { file, args } = spec.buildSpawn(command);
  const child = spawn(file, args, {
    cwd: workingDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // No-op off Windows; on Windows it stops every command from flashing a
    // visible console window over the desktop.
    windowsHide: true,
  });

  const entry: RunningProcess = {
    child,
    cancelled: false,
    hasExited: false,
    settled: false,
    killTimer: null,
  };
  runningProcesses.set(requestId, entry);

  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

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

    if (entry.cancelled || entry.settled) return;
    entry.settled = true;

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

    if (entry.cancelled || entry.settled) return;
    entry.settled = true;

    void poster.postBashResult({
      requestId,
      stdout,
      stderr: stderr || err.message,
      exitCode: 1,
      timedOut: false,
    });
  });
}

function handleCancel(
  message: HostProxySseMessage,
  _poster: HostProxyPoster,
): void {
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

export function createHostShellExecutor(
  spec: HostShellSpec,
): HostProxyExecutor {
  return {
    handleRequest: (message, poster) => handleRequest(spec, message, poster),
    handleCancel,
  };
}

// Test seam
export const __testing = {
  get runningProcesses() {
    return runningProcesses;
  },
};

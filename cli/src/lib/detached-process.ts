import { spawn, type ChildProcess } from "node:child_process";
import { closeSync } from "node:fs";
import { join } from "node:path";

import { isCompiledCli } from "./local.js";
import { getLogDir, openLogFile, resetLogFile } from "./xdg-log.js";

export interface RelaunchDetachedOptions {
  /** argv for the re-invoked CLI command, e.g. ["tunnel", "--provider", "ngrok"]. */
  args: string[];
  /** Log file basename under the XDG log dir; truncated before spawn. */
  logFile: string;
  /**
   * Polled (with the resolved log path) until it resolves truthy, the child
   * exits, or timeoutMs elapses.
   */
  isReady: (logPath: string) => Promise<boolean> | boolean;
  timeoutMs: number;
  pollIntervalMs?: number;
}

export interface DetachedRelaunchResult {
  child: ChildProcess;
  logPath: string;
  /** True once `isReady` returned truthy before the child exited or the timeout elapsed. */
  ready: boolean;
  /** The child's exit code, or `null` for a spawn error. Undefined while still running. */
  exitCode: number | null | undefined;
}

/**
 * Re-invoke the current CLI binary with `args` as a detached background
 * process, redirecting stdout/stderr to `logFile` in the XDG log dir, then
 * poll `isReady` until it succeeds, the child exits, or `timeoutMs` elapses.
 *
 * Shared by every command that offers a detached/background mode (e.g.
 * `vellum tunnel -d`, `vellum client --interface web --background`) so the
 * spawn/log/poll mechanics live in one place; each caller supplies its own
 * readiness check and decides how to react to a timeout or early exit.
 */
export async function relaunchDetached(
  opts: RelaunchDetachedOptions,
): Promise<DetachedRelaunchResult> {
  const spawnArgs = isCompiledCli()
    ? opts.args
    : [process.argv[1], ...opts.args];

  resetLogFile(opts.logFile);
  const fd = openLogFile(opts.logFile);
  const child = spawn(process.execPath, spawnArgs, {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  if (typeof fd === "number") {
    closeSync(fd);
  }
  child.unref();

  const logPath = join(getLogDir(), opts.logFile);

  let exitCode: number | null | undefined;
  child.on("error", () => {
    exitCode = null;
  });
  child.on("exit", (code) => {
    exitCode = code;
  });

  const deadline = Date.now() + opts.timeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  let ready = false;
  while (Date.now() < deadline && exitCode === undefined) {
    if (await opts.isReady(logPath)) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { child, logPath, ready, exitCode };
}

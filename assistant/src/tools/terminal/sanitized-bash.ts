/**
 * Spawn a shell command with the same sanitized environment the bash tool
 * forwards to tool-call subprocesses.
 *
 * Used by `assistant bash` so a CLI invocation sees the same allowlisted
 * env, workspace cwd, and platform shell as a bash tool call, without
 * round-tripping through the assistant HTTP or IPC API.
 */

import { spawn } from "node:child_process";

import {
  buildShellInvocation,
  buildShellSpawnFlags,
  terminateProcessTree,
  watchShellProcessStart,
} from "../../util/host-process.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { SHELL_DID_NOT_START_MESSAGE } from "../shared/shell-output.js";
import { buildSanitizedEnv } from "./safe-env.js";

export const DEFAULT_SANITIZED_BASH_TIMEOUT_MS = 30_000;

export interface SanitizedBashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export function runSanitizedBash(
  command: string,
  timeoutMs: number = DEFAULT_SANITIZED_BASH_TIMEOUT_MS,
): Promise<SanitizedBashResult> {
  if (!command) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "command is required",
    });
  }

  const effectiveTimeout =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_SANITIZED_BASH_TIMEOUT_MS;

  return new Promise<SanitizedBashResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const finish = (result: SanitizedBashResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const wrapped = buildShellInvocation(command);
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: getWorkspaceDir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSanitizedEnv(),
      ...buildShellSpawnFlags(),
    });
    const launch = watchShellProcessStart(child);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, effectiveTimeout);

    child.stdout.on("data", (data: Buffer) => {
      stdoutChunks.push(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!launch.didStart()) {
        finish({
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          error: SHELL_DID_NOT_START_MESSAGE,
        });
        return;
      }
      finish({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        error: err.message,
      });
    });
  });
}

/**
 * Handle bash debug signals delivered via signal files from the CLI.
 *
 * The CLI writes JSON to `signals/bash` containing a command to execute.
 * The daemon's ConfigWatcher detects the file change and invokes
 * {@link handleBashSignal}, which reads the payload, spawns the command,
 * and writes the result to `signals/bash-result` for the CLI to pick up.
 *
 * This is a developer debugging tool for inspecting how the daemon
 * environment executes shell commands.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("signal:bash");

const DEFAULT_TIMEOUT_MS = 30_000;

interface BashSignalPayload {
  requestId: string;
  command: string;
  timeoutMs?: number;
}

interface BashSignalResult {
  requestId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

function writeResult(result: BashSignalResult): void {
  try {
    writeFileSync(
      join(getWorkspaceDir(), "signals", "bash-result"),
      JSON.stringify(result),
    );
  } catch (err) {
    log.error({ err }, "Failed to write bash signal result");
  }
}

/**
 * Read the `signals/bash` file, execute the command, and write the result
 * to `signals/bash-result`. Called by ConfigWatcher when the signal file
 * is written or modified.
 */
export function handleBashSignal(): void {
  let payload: BashSignalPayload;
  try {
    const content = readFileSync(
      join(getWorkspaceDir(), "signals", "bash"),
      "utf-8",
    );
    payload = JSON.parse(content) as BashSignalPayload;
  } catch (err) {
    log.error({ err }, "Failed to read bash signal file");
    return;
  }

  const { requestId, command, timeoutMs } = payload;

  if (!requestId || typeof requestId !== "string") {
    log.warn("Bash signal missing requestId");
    return;
  }
  if (!command || typeof command !== "string") {
    log.warn({ requestId }, "Bash signal missing command");
    return;
  }

  const effectiveTimeout =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;

  log.info({ requestId, command }, "Executing bash signal command");

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;
  let resultWritten = false;

  const child = spawn("bash", ["-c", command], {
    cwd: getWorkspaceDir(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, effectiveTimeout);

  child.stdout.on("data", (data: Buffer) => {
    stdoutChunks.push(data);
  });

  child.stderr.on("data", (data: Buffer) => {
    stderrChunks.push(data);
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    if (resultWritten) return;
    resultWritten = true;

    const stdout = Buffer.concat(stdoutChunks).toString();
    const stderr = Buffer.concat(stderrChunks).toString();

    log.info(
      { requestId, exitCode: code, timedOut },
      "Bash signal command completed",
    );

    writeResult({ requestId, stdout, stderr, exitCode: code, timedOut });
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    if (resultWritten) return;
    resultWritten = true;

    log.error({ err, requestId }, "Failed to spawn bash signal command");
    writeResult({
      requestId,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: err.message,
    });
  });
}

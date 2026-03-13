/**
 * Handle bash debug signals delivered via signal files from the CLI.
 *
 * Each invocation writes JSON to a unique `signals/bash.<requestId>` file.
 * ConfigWatcher detects the new file and invokes {@link handleBashSignal},
 * which reads the payload, spawns the command, and writes the result to
 * `signals/bash.<requestId>.result` for the CLI to pick up.
 *
 * Per-request filenames avoid dropped commands when overlapping invocations
 * race on the same signal file.
 */

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

function writeResult(requestId: string, result: BashSignalResult): void {
  try {
    writeFileSync(
      join(getWorkspaceDir(), "signals", `bash.${requestId}.result`),
      JSON.stringify(result),
    );
  } catch (err) {
    log.error({ err, requestId }, "Failed to write bash signal result");
  }
}

/**
 * Read a `signals/bash.<requestId>` file, execute the command, and write
 * the result to `signals/bash.<requestId>.result`. Called by ConfigWatcher
 * when a matching signal file is created or modified.
 */
export function handleBashSignal(filename: string): void {
  const signalPath = join(getWorkspaceDir(), "signals", filename);
  let raw: string;
  try {
    raw = readFileSync(signalPath, "utf-8");
  } catch {
    // File may already be deleted (e.g. re-trigger from our own unlinkSync).
    return;
  }

  let payload: BashSignalPayload;
  try {
    payload = JSON.parse(raw) as BashSignalPayload;
  } catch (err) {
    log.error({ err, filename }, "Failed to parse bash signal file");
    return;
  }

  try {
    unlinkSync(signalPath);
  } catch {
    // Best-effort cleanup; the file may already be gone.
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

    writeResult(requestId, {
      requestId,
      stdout,
      stderr,
      exitCode: code,
      timedOut,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    if (resultWritten) return;
    resultWritten = true;

    log.error({ err, requestId }, "Failed to spawn bash signal command");
    writeResult(requestId, {
      requestId,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: err.message,
    });
  });
}

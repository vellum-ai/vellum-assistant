import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { getSignalsDir } from "../../util/platform.js";
import { log } from "../logger.js";

const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

interface ShotgunResult {
  requestId: string;
  ok: boolean;
  error?: string;
  watchId?: string;
  conversationId?: string;
  status?: string;
}

function writeShotgunSignal(
  requestId: string,
  payload: Record<string, unknown>,
): { signalPath: string; resultPath: string } | null {
  const signalsDir = getSignalsDir();
  try {
    mkdirSync(signalsDir, { recursive: true });
  } catch {
    log.error("Failed to create signals directory.");
    return null;
  }

  const signalPath = join(signalsDir, `shotgun.${requestId}`);
  const resultPath = join(signalsDir, `shotgun.${requestId}.result`);

  try {
    writeFileSync(signalPath, JSON.stringify({ requestId, ...payload }));
  } catch {
    log.error("Failed to write shotgun signal file.");
    return null;
  }

  return { signalPath, resultPath };
}

function pollForResult(
  requestId: string,
  resultPath: string,
  signalPath: string,
  timeoutMs: number,
  callback: (result: ShotgunResult) => void,
): void {
  const deadline = Date.now() + timeoutMs + 5_000;

  const poll = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(poll);
      cleanup(signalPath, resultPath);
      log.error("Timed out waiting for response. Is the assistant running?");
      process.exitCode = 1;
      return;
    }

    if (!existsSync(resultPath)) return;

    let result: ShotgunResult;
    try {
      const content = readFileSync(resultPath, "utf-8");
      result = JSON.parse(content) as ShotgunResult;
    } catch {
      return;
    }

    if (result.requestId !== requestId) return;

    clearInterval(poll);
    cleanup(signalPath, resultPath);
    callback(result);
  }, POLL_INTERVAL_MS);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // Best-effort cleanup.
    }
  }
}

export function registerShotgunCommand(program: Command): void {
  const shotgun = program
    .command("shotgun")
    .description("Start and monitor screen-watch (shotgun) sessions via IPC");

  shotgun
    .command("start")
    .description("Start a new screen-watch session")
    .option(
      "-d, --duration <seconds>",
      "Duration in seconds for the watch session",
      "300",
    )
    .option("-i, --interval <seconds>", "Seconds between screen captures", "5")
    .option(
      "-f, --focus <area>",
      "What to focus on observing",
      "general observation",
    )
    .option(
      "-t, --timeout <ms>",
      "Timeout in milliseconds waiting for the assistant to respond",
      String(DEFAULT_TIMEOUT_MS),
    )
    .addHelpText(
      "after",
      `
Starts a screen-watch session via IPC signal files. The assistant
creates a watch session and begins accepting screen observations from the
desktop client.

The CLI writes the request to signals/shotgun.<requestId> and polls
signals/shotgun.<requestId>.result for the response. The assistant must
be running for this to work.

Output (JSON): { ok, watchId, conversationId }

Examples:
  $ assistant shotgun start
  $ assistant shotgun start --duration 600 --interval 10 --focus "doordash.com"
  $ assistant shotgun start -d 300 -i 5 -f "browsing workflow"`,
    )
    .action(
      (opts: {
        duration: string;
        interval: string;
        focus: string;
        timeout: string;
      }) => {
        const durationSeconds = parseInt(opts.duration, 10);
        if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
          log.error("Invalid duration. Must be a positive integer.");
          process.exitCode = 1;
          return;
        }

        const intervalSeconds = parseInt(opts.interval, 10);
        if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
          log.error("Invalid interval. Must be a positive integer.");
          process.exitCode = 1;
          return;
        }

        const timeoutMs = parseInt(opts.timeout, 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
          log.error("Invalid timeout. Must be a positive integer.");
          process.exitCode = 1;
          return;
        }

        const requestId = randomUUID();
        const paths = writeShotgunSignal(requestId, {
          action: "start",
          durationSeconds,
          intervalSeconds,
          focusArea: opts.focus,
        });
        if (!paths) {
          process.exitCode = 1;
          return;
        }

        pollForResult(
          requestId,
          paths.resultPath,
          paths.signalPath,
          timeoutMs,
          (result) => {
            if (!result.ok) {
              process.stdout.write(JSON.stringify(result) + "\n");
              process.exitCode = 1;
              return;
            }
            process.stdout.write(JSON.stringify(result) + "\n");
          },
        );
      },
    );

  shotgun
    .command("status <watchId>")
    .description("Check the status of an active screen-watch session")
    .option(
      "-t, --timeout <ms>",
      "Timeout in milliseconds waiting for the assistant to respond",
      String(DEFAULT_TIMEOUT_MS),
    )
    .addHelpText(
      "after",
      `
Queries the status of an existing screen-watch session by watchId.

Output (JSON): { ok, watchId, conversationId, status }

The status field is one of: "active", "completing", "completed", "cancelled".

Examples:
  $ assistant shotgun status abc12345
  $ assistant shotgun status abc12345 --timeout 5000`,
    )
    .action((watchId: string, opts: { timeout: string }) => {
      const timeoutMs = parseInt(opts.timeout, 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
        log.error("Invalid timeout. Must be a positive integer.");
        process.exitCode = 1;
        return;
      }

      const requestId = randomUUID();
      const paths = writeShotgunSignal(requestId, {
        action: "status",
        watchId,
      });
      if (!paths) {
        process.exitCode = 1;
        return;
      }

      pollForResult(
        requestId,
        paths.resultPath,
        paths.signalPath,
        timeoutMs,
        (result) => {
          process.stdout.write(JSON.stringify(result) + "\n");
          if (!result.ok) {
            process.exitCode = 1;
          }
        },
      );
    });
}

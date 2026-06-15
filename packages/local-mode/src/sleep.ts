import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

const SLEEP_TIMEOUT_MS = 60_000;

export type SleepResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Stop a local assistant's daemon and gateway via the CLI's `sleep --force`.
 *
 * Uses `--force` to bypass the active-call-lease guard — the restart flow
 * immediately follows with a `wake`, so the brief interruption is expected
 * and user-confirmed at the UI level.
 *
 * Mirrors {@link runRetire}'s never-reject contract so each host wires
 * transport once and surfaces a structured failure rather than a thrown error.
 */
export function runSleep(
  invocation: CliInvocation,
  assistantId: string,
): Promise<SleepResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, "sleep", assistantId, "--force"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: SleepResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: `Sleep timed out after ${SLEEP_TIMEOUT_MS / 1000} seconds`,
      });
    }, SLEEP_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, status: 500, error: stderr || stdout });
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        status: 500,
        error: `Failed to spawn CLI: ${err.message}`,
      });
    });
  });
}

import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

const WAKE_TIMEOUT_MS = 60_000;

export type WakeResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Start (or restart) a local assistant's daemon and gateway via the CLI's
 * `wake`, which also re-seeds the guardian token from a sibling environment.
 *
 * This is the non-destructive repair primitive: it revives a stopped or
 * mis-seeded local assistant in place without touching its data or identity,
 * the same way the native client re-pairs on a failed connection. Mirrors
 * {@link runRetire}'s never-reject contract so each host wires transport once
 * and surfaces a structured failure rather than a thrown error.
 */
export function runWake(
  invocation: CliInvocation,
  assistantId: string,
): Promise<WakeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, "wake", assistantId],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: WakeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, status: 500, error: "Wake timed out after 60 seconds" });
    }, WAKE_TIMEOUT_MS);

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
      finish({ ok: false, status: 500, error: `Failed to spawn CLI: ${err.message}` });
    });
  });
}

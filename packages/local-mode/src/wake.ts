import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

// `wake` cold-starts a stopped assistant, so it can legitimately run far
// longer than a teardown like `retire`: the CLI waits up to 60s for the daemon
// to answer (plus another 60s if it falls back to a source daemon) and up to
// 30s for the gateway. The wrapper timeout is a safety net for a truly hung
// process, so it must sit above those documented readiness windows — otherwise
// a slow-but-succeeding wake gets killed and misreported as a timeout.
const WAKE_TIMEOUT_MS = 180_000;

export type WakeResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export interface WakeOptions {
  /** Pass --repair-guardian to re-provision a missing/expired guardian token. Revokes the assistant's other device-bound tokens, so callers must gate this behind explicit user confirmation. */
  repairGuardian?: boolean;
}

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
  options?: WakeOptions,
): Promise<WakeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [
        ...invocation.baseArgs,
        "wake",
        assistantId,
        ...(options?.repairGuardian ? ["--repair-guardian"] : []),
      ],
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
      finish({
        ok: false,
        status: 500,
        error: `Wake timed out after ${WAKE_TIMEOUT_MS / 1000} seconds`,
      });
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

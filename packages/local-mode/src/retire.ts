import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

const RETIRE_TIMEOUT_MS = 60_000;

export type RetireResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function runRetire(
  invocation: CliInvocation,
  assistantId: string,
): Promise<RetireResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, "retire", assistantId, "--yes"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: RetireResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, status: 500, error: "Retire timed out after 60 seconds" });
    }, RETIRE_TIMEOUT_MS);

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

import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

const HATCH_TIMEOUT_MS = 120_000;

export type HatchResult =
  | { ok: true; assistantId: string }
  | { ok: false; status: number; error: string };

export function runHatch(
  invocation: CliInvocation,
  species: string,
): Promise<HatchResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, "hatch", species],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: HatchResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, status: 500, error: "Hatch timed out after 120 seconds" });
    }, HATCH_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const error =
          stderr.trim() ||
          stdout.trim() ||
          `Hatch failed: the CLI exited with code ${code ?? "unknown"} and produced no output.`;
        finish({ ok: false, status: 500, error });
        return;
      }
      const assistantId = stdout
        .match(/Hatching local assistant:\s+(.+)/)?.[1]
        ?.trim();
      if (!assistantId) {
        finish({
          ok: false,
          status: 500,
          error:
            "Hatch reported success but no assistant id was found in the CLI output.",
        });
        return;
      }
      finish({ ok: true, assistantId });
    });

    child.on("error", (err) => {
      finish({ ok: false, status: 500, error: `Failed to spawn CLI: ${err.message}` });
    });
  });
}

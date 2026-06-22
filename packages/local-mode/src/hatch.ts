import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

const HATCH_TIMEOUT_MS = 120_000;
// Docker hatches pull images and wait up to 5 min for container readiness.
const DOCKER_HATCH_TIMEOUT_MS = 10 * 60 * 1000;

export type HatchResult =
  | { ok: true; assistantId: string }
  | { ok: false; status: number; error: string };

export interface RunHatchOptions {
  remote?: string;
}

export function runHatch(
  invocation: CliInvocation,
  species: string,
  options?: RunHatchOptions,
): Promise<HatchResult> {
  return new Promise((resolve) => {
    const args = [...invocation.baseArgs, "hatch", species];
    if (options?.remote) {
      args.push("--remote", options.remote);
    }

    const child = spawn(
      invocation.command,
      args,
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

    const timeoutMs =
      options?.remote === "docker" ? DOCKER_HATCH_TIMEOUT_MS : HATCH_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: `Hatch timed out after ${timeoutMs / 1000} seconds`,
      });
    }, timeoutMs);

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
        .match(/Hatching (?:local|Docker) assistant:\s+(.+)/)?.[1]
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

import { spawn } from "node:child_process";

const HATCH_TIMEOUT_MS = 120_000;

export type HatchResult =
  | { ok: true; assistantId: string }
  | { ok: false; status: number; error: string };

export function runHatch(species: string, cliPath: string): Promise<HatchResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cliPath, "hatch", species], {
      stdio: ["ignore", "pipe", "pipe"],
    });

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
      if (code === 0) {
        const match = stdout.match(/Hatching local assistant:\s+(.+)/);
        const assistantId = match?.[1]?.trim() ?? "";
        finish({ ok: true, assistantId });
      } else {
        finish({ ok: false, status: 500, error: stderr || stdout });
      }
    });

    child.on("error", (err) => {
      finish({ ok: false, status: 500, error: `Failed to spawn CLI: ${err.message}` });
    });
  });
}

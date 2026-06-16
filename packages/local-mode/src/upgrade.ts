import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

const UPGRADE_TIMEOUT_MS = 20 * 60 * 1000;

export type UpgradeResult =
  | { ok: true; version?: string }
  | { ok: false; status: number; error: string };

export interface UpgradeOptions {
  version?: string;
  latest?: boolean;
  force?: boolean;
}

function extractVersion(output: string): string | undefined {
  const versionPattern = "(v?[0-9]+(?:\\.[0-9]+)*(?:[-+][\\w.-]+)?)";
  const upgraded = output.match(
    new RegExp(`\\bupgraded to\\s+${versionPattern}`, "i"),
  )?.[1];
  if (upgraded) return upgraded;

  return output.match(new RegExp(`\\bAlready on\\s+${versionPattern}`, "i"))?.[1];
}

/**
 * Upgrade a local assistant via the CLI. The CLI owns the full lifecycle
 * (backup, process restart, health wait, rollback on failure); the host
 * bridge only starts it and returns the structured result to the renderer.
 */
export function runUpgrade(
  invocation: CliInvocation,
  assistantId: string,
  options?: UpgradeOptions,
): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    const args = [...invocation.baseArgs, "upgrade", assistantId];
    if (options?.latest) {
      args.push("--latest");
    } else if (options?.version) {
      args.push("--version", options.version);
    }
    if (options?.force) {
      args.push("--force");
    }

    const child = spawn(invocation.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: UpgradeResult) => {
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
        error: `Upgrade timed out after ${UPGRADE_TIMEOUT_MS / 1000} seconds`,
      });
    }, UPGRADE_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const version = extractVersion(stdout);
        finish(version ? { ok: true, version } : { ok: true });
        return;
      }

      finish({
        ok: false,
        status: 500,
        error:
          stderr.trim() ||
          stdout.trim() ||
          `Upgrade failed: the CLI exited with code ${code ?? "unknown"} and produced no output.`,
      });
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

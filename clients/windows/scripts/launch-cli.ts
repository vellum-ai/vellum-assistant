import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { withRuntimeNodePath } from "../src/shared/runtime-environment";
import { sameWindowsPath } from "../src/shared/windows-path";

interface LauncherOwnership {
  sourcePath: string;
}

type SpawnCli = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
    windowsHide: boolean;
  },
) => { error?: Error; status: number | null };

export function resolveOwnedCliTarget(execPath: string): string {
  const ownershipPath = path.join(path.dirname(execPath), ".vellum-owned.json");
  let ownership: LauncherOwnership;
  try {
    ownership = JSON.parse(
      readFileSync(ownershipPath, "utf8"),
    ) as LauncherOwnership;
  } catch {
    throw new Error("The Vellum CLI launcher ownership file is invalid.");
  }
  if (
    typeof ownership.sourcePath !== "string" ||
    sameWindowsPath(ownership.sourcePath, execPath) ||
    !existsSync(ownership.sourcePath)
  ) {
    throw new Error("The installed Vellum CLI runtime is unavailable.");
  }
  return ownership.sourcePath;
}

export function launchOwnedCli(
  execPath: string,
  args: string[],
  spawnCli: SpawnCli = (command, commandArgs, options) =>
    spawnSync(command, commandArgs, options),
): number {
  const target = resolveOwnedCliTarget(execPath);
  const result = spawnCli(target, args, {
    env: withRuntimeNodePath(target),
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (import.meta.main) {
  try {
    process.exitCode = launchOwnedCli(process.execPath, process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

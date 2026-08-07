import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { CLI_RUNTIME_ENTRIES } from "./cli-installer";

export type CliLauncherState =
  "missing" | "foreign" | "installed" | "shadowed" | "stale";

type LauncherOwnership = {
  ownerId?: string;
  sourcePath: string;
  version: string;
};

export interface CliLauncherPaths {
  binDir: string;
  executable: string;
  ownership: string;
}

export type RegistryRunner = (
  command: string,
  args: string[],
) => string | undefined;

export const systemRegistryRunner: RegistryRunner = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });

const sameWindowsPath = (left: string, right: string): boolean =>
  path.win32.resolve(left) === path.win32.resolve(right);

export function resolveCliLauncherPaths(
  localAppData: string,
): CliLauncherPaths {
  const binDir = path.join(localAppData, "Vellum", "bin");
  return {
    binDir,
    executable: path.join(binDir, "vellum.exe"),
    ownership: path.join(binDir, ".vellum-owned.json"),
  };
}

function readOwnership(paths: CliLauncherPaths): LauncherOwnership | undefined {
  try {
    const ownership = JSON.parse(
      readFileSync(paths.ownership, "utf8"),
    ) as LauncherOwnership;
    return typeof ownership.sourcePath === "string" &&
      typeof ownership.version === "string" &&
      (ownership.ownerId === undefined || typeof ownership.ownerId === "string")
      ? ownership
      : undefined;
  } catch {
    return undefined;
  }
}

export function getCliLauncherState(
  paths: CliLauncherPaths,
  sourcePath?: string,
  userPath?: string,
): CliLauncherState {
  const runtimeExists = CLI_RUNTIME_ENTRIES.every((name) =>
    existsSync(path.join(paths.binDir, name)),
  );
  const ownership = readOwnership(paths);
  if (!ownership) {
    return CLI_RUNTIME_ENTRIES.some((name) =>
      existsSync(path.join(paths.binDir, name)),
    )
      ? "foreign"
      : "missing";
  }
  if (!runtimeExists) {
    return "stale";
  }
  if (
    sourcePath &&
    path.resolve(ownership.sourcePath) !== path.resolve(sourcePath)
  ) {
    return "stale";
  }
  if (userPath) {
    const entries = userPath.split(";").filter(Boolean);
    const ownIndex = entries.findIndex((entry) =>
      sameWindowsPath(entry, paths.binDir),
    );
    const earlierEntries = entries.slice(
      0,
      ownIndex < 0 ? entries.length : ownIndex,
    );
    if (
      earlierEntries.some((entry) => existsSync(path.join(entry, "vellum.exe")))
    ) {
      return "shadowed";
    }
    if (ownIndex < 0) {
      return "stale";
    }
  }
  return "installed";
}

export function readUserPath(
  run: RegistryRunner = systemRegistryRunner,
): string | undefined {
  try {
    const output = run("reg.exe", ["QUERY", "HKCU\\Environment"]);
    const match = output?.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im);
    if (match) {
      return match[1].trim();
    }
    return /\bPath\s+REG_/i.test(output ?? "") ? undefined : "";
  } catch {
    return undefined;
  }
}

function writeUserPath(value: string, run: RegistryRunner): void {
  run("reg.exe", [
    "ADD",
    "HKCU\\Environment",
    "/v",
    "Path",
    "/t",
    "REG_EXPAND_SZ",
    "/d",
    value,
    "/f",
  ]);
}

export function ensureUserPath(
  binDir: string,
  run: RegistryRunner = systemRegistryRunner,
): void {
  const current = readUserPath(run);
  if (current === undefined) {
    throw new Error("Unable to read the Windows user PATH.");
  }
  const entries = current.split(";").filter(Boolean);
  if (!entries.some((entry) => sameWindowsPath(entry, binDir))) {
    writeUserPath([...entries, binDir].join(";"), run);
  }
}

export function installCliLauncher(
  sourcePath: string,
  version: string,
  paths: CliLauncherPaths,
  run: RegistryRunner = systemRegistryRunner,
  ownerId?: string,
): CliLauncherState {
  const initialState = getCliLauncherState(paths, sourcePath);
  if (initialState === "foreign") {
    return initialState;
  }
  mkdirSync(paths.binDir, { recursive: true });
  const files: Array<{ source?: string; contents?: string; target: string }> = [
    ...CLI_RUNTIME_ENTRIES.map((name) => ({
      source: path.join(path.dirname(sourcePath), name),
      target: path.join(paths.binDir, name),
    })),
    {
      contents: `${JSON.stringify({ ownerId, sourcePath, version })}\n`,
      target: paths.ownership,
    },
  ];
  const pending = files.map((file) => ({
    ...file,
    staging: `${file.target}.${process.pid}.tmp`,
    backup: `${file.target}.${process.pid}.backup`,
  }));
  for (const file of pending) {
    rmSync(file.staging, { recursive: true, force: true });
    rmSync(file.backup, { recursive: true, force: true });
  }
  if (pending.some((file) => file.source && !existsSync(file.source))) {
    throw new Error("The provisioned Windows CLI runtime is incomplete.");
  }
  for (const file of pending) {
    if (file.source) {
      cpSync(file.source, file.staging, { recursive: true });
    } else {
      writeFileSync(file.staging, file.contents ?? "", "utf8");
    }
  }
  const replaced: typeof pending = [];
  try {
    for (const file of pending) {
      replaced.push(file);
      if (existsSync(file.target)) {
        renameSync(file.target, file.backup);
      }
      renameSync(file.staging, file.target);
    }
    ensureUserPath(paths.binDir, run);
    for (const file of pending) {
      rmSync(file.backup, { recursive: true, force: true });
    }
    return getCliLauncherState(paths, sourcePath, readUserPath(run));
  } catch (error) {
    for (const file of replaced.reverse()) {
      rmSync(file.staging, { recursive: true, force: true });
      rmSync(file.target, { recursive: true, force: true });
      if (existsSync(file.backup)) {
        renameSync(file.backup, file.target);
      }
    }
    throw error;
  }
}

export function uninstallCliLauncher(
  paths: CliLauncherPaths,
  run: RegistryRunner = systemRegistryRunner,
  expectedOwnerId?: string,
): boolean {
  const ownership = readOwnership(paths);
  if (
    !ownership ||
    (expectedOwnerId &&
      (!ownership.ownerId ||
        !sameWindowsPath(ownership.ownerId, expectedOwnerId)))
  ) {
    return false;
  }
  const userPath = readUserPath(run);
  if (userPath === undefined) {
    throw new Error("Unable to read the Windows user PATH.");
  }
  const pending = CLI_RUNTIME_ENTRIES.filter((name) =>
    existsSync(path.join(paths.binDir, name)),
  ).map((name) => ({
    target: path.join(paths.binDir, name),
    staging: path.join(paths.binDir, `.${name}.${process.pid}.uninstalling`),
  }));
  const moved: typeof pending = [];
  const restoreMoved = (): void => {
    for (const file of moved.reverse()) {
      if (!existsSync(file.target) && existsSync(file.staging)) {
        try {
          renameSync(file.staging, file.target);
        } catch {}
      }
    }
  };
  try {
    for (const file of pending) {
      if (existsSync(file.staging)) {
        restoreMoved();
        return false;
      }
      renameSync(file.target, file.staging);
      moved.push(file);
    }
  } catch {
    restoreMoved();
    return false;
  }
  const entries = userPath
    .split(";")
    .filter((entry) => entry && !sameWindowsPath(entry, paths.binDir));
  try {
    writeUserPath(entries.join(";"), run);
  } catch (error) {
    restoreMoved();
    throw error;
  }
  for (const file of moved) {
    try {
      rmSync(file.staging, { recursive: true, force: true });
    } catch {}
  }
  if (moved.some((file) => existsSync(file.staging))) {
    return false;
  }
  rmSync(paths.ownership, { force: true });
  return true;
}

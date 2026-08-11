import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type CliLauncherState =
  | "missing"
  | "foreign"
  | "installed"
  | "shadowed"
  | "stale";

type LauncherOwnership = { sourcePath: string; version: string };

export interface CliLauncherPaths {
  binDir: string;
  executable: string;
  bunExecutable: string;
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
    bunExecutable: path.join(binDir, "bun.exe"),
    ownership: path.join(binDir, ".vellum-owned.json"),
  };
}

function readOwnership(paths: CliLauncherPaths): LauncherOwnership | undefined {
  try {
    const ownership = JSON.parse(
      readFileSync(paths.ownership, "utf8"),
    ) as LauncherOwnership;
    return typeof ownership.sourcePath === "string" &&
      typeof ownership.version === "string"
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
  const vellumExists = existsSync(paths.executable);
  const bunExists = existsSync(paths.bunExecutable);
  const ownership = readOwnership(paths);
  if (!ownership) {
    return vellumExists || bunExists ? "foreign" : "missing";
  }
  if (!vellumExists || !bunExists) {
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
  return readRegistryPath("HKCU\\Environment", run);
}

export function readMachinePath(
  run: RegistryRunner = systemRegistryRunner,
): string | undefined {
  return readRegistryPath(
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    run,
  );
}

function readRegistryPath(
  key: string,
  run: RegistryRunner,
): string | undefined {
  try {
    const output = run("reg.exe", ["QUERY", key]);
    const match = output?.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im);
    if (match) {
      return match[1].trim();
    }
    return /\bPath\s+REG_/i.test(output ?? "") ? undefined : "";
  } catch {
    return undefined;
  }
}

function readEffectivePath(run: RegistryRunner): string | undefined {
  const machinePath = readMachinePath(run);
  const userPath = readUserPath(run);
  if (machinePath === undefined || userPath === undefined) {
    return undefined;
  }
  return [machinePath, userPath].filter(Boolean).join(";");
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
): CliLauncherState {
  const initialState = getCliLauncherState(paths, sourcePath);
  if (initialState === "foreign") {
    return initialState;
  }
  mkdirSync(paths.binDir, { recursive: true });
  const files: Array<{ source?: string; contents?: string; target: string }> = [
    { source: sourcePath, target: paths.executable },
    {
      source: path.join(path.dirname(sourcePath), "bun.exe"),
      target: paths.bunExecutable,
    },
    {
      contents: `${JSON.stringify({ sourcePath, version })}\n`,
      target: paths.ownership,
    },
  ];
  const pending = files.map((file) => ({
    ...file,
    staging: `${file.target}.${process.pid}.tmp`,
    backup: `${file.target}.${process.pid}.backup`,
  }));
  for (const file of pending) {
    rmSync(file.staging, { force: true });
    rmSync(file.backup, { force: true });
  }
  if (pending.some((file) => file.source && !existsSync(file.source))) {
    throw new Error("The provisioned Windows CLI runtime is incomplete.");
  }
  for (const file of pending) {
    if (file.source) {
      copyFileSync(file.source, file.staging);
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
    const effectivePath = readEffectivePath(run);
    if (effectivePath === undefined) {
      throw new Error("Unable to read the effective Windows PATH.");
    }
    for (const file of pending) {
      rmSync(file.backup, { force: true });
    }
    return getCliLauncherState(paths, sourcePath, effectivePath);
  } catch (error) {
    for (const file of replaced.reverse()) {
      rmSync(file.staging, { force: true });
      rmSync(file.target, { force: true });
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
): boolean {
  if (!readOwnership(paths)) {
    return false;
  }
  const userPath = readUserPath(run);
  if (userPath === undefined) {
    throw new Error("Unable to read the Windows user PATH.");
  }
  const entries = userPath
    .split(";")
    .filter((entry) => entry && !sameWindowsPath(entry, paths.binDir));
  writeUserPath(entries.join(";"), run);
  rmSync(paths.executable, { force: true });
  rmSync(paths.bunExecutable, { force: true });
  rmSync(paths.ownership, { force: true });
  return true;
}

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
import {
  normalizeWindowsPathEntry,
  sameWindowsPath,
} from "../shared/windows-path";

export { normalizeWindowsPathEntry } from "../shared/windows-path";

export type CliLauncherState =
  | "missing"
  | "foreign"
  | "installed"
  | "shadowed"
  | "stale";
export type CliLauncherUninstallResult = "removed" | "not-owned" | "blocked";

type LauncherOwnership = {
  launcherVersion?: number;
  ownerId?: string;
  sourcePath: string;
  version: string;
};

export interface CliLauncherPaths {
  binDir: string;
  executable: string;
  ownership: string;
}

export interface CliLauncherFileOperations {
  removeBackupFile?: typeof rmSync;
  renameFile?: typeof renameSync;
}

export interface CliLauncherInstallOptions extends CliLauncherFileOperations {
  ownerId?: string;
}

const LAUNCHER_VERSION = 1;
const LEGACY_LAUNCHER_ENTRIES = ["vellum.exe", "bun.exe"] as const;

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

const ENVIRONMENT_CHANGE_SCRIPT = [
  "$signature = '[System.Runtime.InteropServices.DllImport(\"user32.dll\", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint message, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'",
  "$native = Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace Vellum -PassThru",
  "$result = [UIntPtr]::Zero",
  '$native::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$result) | Out-Null',
].join("; ");

export function resolveCliLauncherPaths(
  localAppData: string,
  releaseChannel = "production",
): CliLauncherPaths {
  const channelSegment = releaseChannel
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  const installName =
    releaseChannel === "production"
      ? "Vellum"
      : `Vellum-${channelSegment || "nonproduction"}`;
  const binDir = path.join(localAppData, installName, "bin");
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

function isLegacyOwnership(ownership: LauncherOwnership): boolean {
  return (
    ownership.launcherVersion === undefined && ownership.ownerId === undefined
  );
}

function isOwnedByExpectedInstaller(
  ownership: LauncherOwnership,
  expectedOwnerId?: string,
): boolean {
  if (!expectedOwnerId) {
    return true;
  }
  if (ownership.ownerId !== undefined) {
    return sameWindowsPath(ownership.ownerId, expectedOwnerId);
  }
  return isLegacyOwnership(ownership);
}

export function getCliLauncherState(
  paths: CliLauncherPaths,
  sourcePath?: string,
  userPath?: string,
): CliLauncherState {
  const launcherExists = existsSync(paths.executable);
  const legacyRuntimeExists = CLI_RUNTIME_ENTRIES.some((name) =>
    existsSync(path.join(paths.binDir, name)),
  );
  const ownership = readOwnership(paths);
  if (!ownership) {
    return launcherExists || legacyRuntimeExists ? "foreign" : "missing";
  }
  if (!launcherExists) {
    return "stale";
  }
  if (sourcePath && !sameWindowsPath(ownership.sourcePath, sourcePath)) {
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
      earlierEntries.some((entry) =>
        existsSync(path.join(normalizeWindowsPathEntry(entry), "vellum.exe")),
      )
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
  try {
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ENVIRONMENT_CHANGE_SCRIPT,
    ]);
  } catch {}
}

export function ensureUserPath(
  binDir: string,
  run: RegistryRunner = systemRegistryRunner,
): string | undefined {
  const current = readUserPath(run);
  if (current === undefined) {
    throw new Error("Unable to read the Windows user PATH.");
  }
  const entries = current.split(";").filter(Boolean);
  if (!entries.some((entry) => sameWindowsPath(entry, binDir))) {
    writeUserPath([...entries, binDir].join(";"), run);
    return current;
  }
  return undefined;
}

function ensureLauncherPath(
  paths: CliLauncherPaths,
  sourcePath: string,
  run: RegistryRunner,
): CliLauncherState {
  const previousUserPath = ensureUserPath(paths.binDir, run);
  try {
    const effectivePath = readEffectivePath(run);
    if (effectivePath === undefined) {
      throw new Error("Unable to read the effective Windows PATH.");
    }
    return getCliLauncherState(paths, sourcePath, effectivePath);
  } catch (error) {
    if (previousUserPath !== undefined) {
      try {
        writeUserPath(previousUserPath, run);
      } catch {}
    }
    throw error;
  }
}

function removeLegacyRuntimeEntries(paths: CliLauncherPaths): void {
  for (const name of CLI_RUNTIME_ENTRIES) {
    if (name === "vellum.exe") {
      continue;
    }
    try {
      rmSync(path.join(paths.binDir, name), { recursive: true, force: true });
    } catch {}
  }
}

export function installCliLauncher(
  sourcePath: string,
  version: string,
  paths: CliLauncherPaths,
  run: RegistryRunner = systemRegistryRunner,
  options: CliLauncherInstallOptions = {},
): CliLauncherState {
  const renameFile = options.renameFile ?? renameSync;
  const removeBackupFile = options.removeBackupFile ?? rmSync;
  const initialState = getCliLauncherState(paths, sourcePath);
  if (initialState === "foreign") {
    return initialState;
  }
  const ownership = readOwnership(paths);
  const reusesLauncher =
    initialState === "installed" &&
    ownership?.launcherVersion === LAUNCHER_VERSION &&
    ownership.version === version;
  if (
    reusesLauncher &&
    isOwnedByExpectedInstaller(ownership, options.ownerId)
  ) {
    const launcherState = ensureLauncherPath(paths, sourcePath, run);
    removeLegacyRuntimeEntries(paths);
    return launcherState;
  }
  mkdirSync(paths.binDir, { recursive: true });
  const files: Array<{ source?: string; contents?: string; target: string }> = [
    {
      contents: `${JSON.stringify({ launcherVersion: LAUNCHER_VERSION, ownerId: options.ownerId, sourcePath, version })}\n`,
      target: paths.ownership,
    },
  ];
  if (!reusesLauncher) {
    files.unshift({
      source: path.join(path.dirname(sourcePath), "cli-launcher.exe"),
      target: paths.executable,
    });
  }
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
  const replaced: Array<{
    file: (typeof pending)[number];
    hadBackup: boolean;
  }> = [];
  try {
    for (const file of pending) {
      const hadBackup = existsSync(file.target);
      if (hadBackup) {
        renameFile(file.target, file.backup);
      }
      try {
        renameFile(file.staging, file.target);
      } catch (error) {
        if (hadBackup && !existsSync(file.target) && existsSync(file.backup)) {
          try {
            renameFile(file.backup, file.target);
          } catch {}
        }
        throw error;
      }
      replaced.push({ file, hadBackup });
    }
    const launcherState = ensureLauncherPath(paths, sourcePath, run);
    for (const file of pending) {
      try {
        removeBackupFile(file.backup, { recursive: true, force: true });
      } catch {}
    }
    removeLegacyRuntimeEntries(paths);
    return launcherState;
  } catch (error) {
    for (const { file, hadBackup } of replaced.reverse()) {
      try {
        rmSync(file.target, { recursive: true, force: true });
      } catch {
        continue;
      }
      if (hadBackup && existsSync(file.backup)) {
        try {
          renameFile(file.backup, file.target);
        } catch {}
      }
    }
    for (const file of pending) {
      try {
        rmSync(file.staging, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
}

export function uninstallCliLauncher(
  paths: CliLauncherPaths,
  run: RegistryRunner = systemRegistryRunner,
  expectedOwnerId?: string,
): CliLauncherUninstallResult {
  const ownership = readOwnership(paths);
  if (!ownership || !isOwnedByExpectedInstaller(ownership, expectedOwnerId)) {
    return "not-owned";
  }
  const userPath = readUserPath(run);
  if (userPath === undefined) {
    throw new Error("Unable to read the Windows user PATH.");
  }
  const ownedTargets = isLegacyOwnership(ownership)
    ? LEGACY_LAUNCHER_ENTRIES.map((name) => path.join(paths.binDir, name))
    : [paths.executable];
  const pending = ownedTargets
    .map((target) => ({
      target,
      staging: path.join(
        paths.binDir,
        `.${path.basename(target)}.uninstalling`,
      ),
    }))
    .filter((file) => existsSync(file.target) || existsSync(file.staging));
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
      if (existsSync(file.target) && existsSync(file.staging)) {
        restoreMoved();
        return "blocked";
      }
      if (!existsSync(file.staging)) {
        renameSync(file.target, file.staging);
      }
      moved.push(file);
    }
  } catch {
    restoreMoved();
    return "blocked";
  }
  const currentEntries = userPath.split(";").filter(Boolean);
  const entries = currentEntries.filter(
    (entry) => !sameWindowsPath(entry, paths.binDir),
  );
  if (entries.length !== currentEntries.length) {
    try {
      writeUserPath(entries.join(";"), run);
    } catch (error) {
      restoreMoved();
      throw error;
    }
  }
  for (const file of moved) {
    try {
      rmSync(file.staging, { recursive: true, force: true });
    } catch {}
  }
  if (moved.some((file) => existsSync(file.staging))) {
    return "blocked";
  }
  rmSync(paths.ownership, { force: true });
  return "removed";
}

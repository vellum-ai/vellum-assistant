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
  "missing" | "foreign" | "installed" | "shadowed" | "stale";

type LauncherOwnership = { sourcePath: string; version: string };

export interface CliLauncherPaths {
  binDir: string;
  executable: string;
  bunExecutable: string;
  ownership: string;
}

export interface CliLauncherFileOperations {
  removeBackupFile?: typeof rmSync;
  renameFile?: typeof renameSync;
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

export function normalizeWindowsPathEntry(
  entry: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = entry.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replace(/%([^%]+)%/g, (match, name: string) => {
    const key = Object.keys(environment).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key ? (environment[key] ?? match) : match;
  });
}

const sameWindowsPath = (left: string, right: string): boolean =>
  path.win32.resolve(normalizeWindowsPathEntry(left)).toLowerCase() ===
  path.win32.resolve(normalizeWindowsPathEntry(right)).toLowerCase();

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

export function installCliLauncher(
  sourcePath: string,
  version: string,
  paths: CliLauncherPaths,
  run: RegistryRunner = systemRegistryRunner,
  fileOperations: CliLauncherFileOperations = {},
): CliLauncherState {
  const renameFile = fileOperations.renameFile ?? renameSync;
  const removeBackupFile = fileOperations.removeBackupFile ?? rmSync;
  const initialState = getCliLauncherState(paths, sourcePath);
  if (initialState === "foreign") {
    return initialState;
  }
  const ownership = readOwnership(paths);
  if (initialState === "installed" && ownership?.version === version) {
    return ensureLauncherPath(paths, sourcePath, run);
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
        removeBackupFile(file.backup, { force: true });
      } catch {}
    }
    return launcherState;
  } catch (error) {
    for (const { file, hadBackup } of replaced.reverse()) {
      try {
        rmSync(file.target, { force: true });
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
        rmSync(file.staging, { force: true });
      } catch {}
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

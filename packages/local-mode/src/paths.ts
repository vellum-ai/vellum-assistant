import os from "node:os";
import path from "node:path";

export interface LocalPathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
}

function platformPath(options: LocalPathOptions): typeof path.posix {
  return (options.platform ?? process.platform) === "win32"
    ? path.win32
    : path.posix;
}

function homeDir(options: LocalPathOptions): string {
  return options.homeDir ?? os.homedir();
}

export function resolveConfigHome(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  const paths = platformPath(options);
  if ((options.platform ?? process.platform) === "win32") {
    return (
      env.APPDATA?.trim() || paths.join(homeDir(options), "AppData", "Roaming")
    );
  }
  return env.XDG_CONFIG_HOME?.trim() || paths.join(homeDir(options), ".config");
}

export function resolveDataHome(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  const paths = platformPath(options);
  if ((options.platform ?? process.platform) === "win32") {
    return (
      env.LOCALAPPDATA?.trim() ||
      paths.join(homeDir(options), "AppData", "Local")
    );
  }
  return (
    env.XDG_DATA_HOME?.trim() || paths.join(homeDir(options), ".local", "share")
  );
}

export function joinLocalPath(
  options: LocalPathOptions,
  ...segments: string[]
): string {
  return platformPath(options).join(...segments);
}

export function assertSafePathSegment(
  value: string,
  label: string,
  options: LocalPathOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const invalidWindowsName =
    /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    (platform === "win32" && invalidWindowsName)
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

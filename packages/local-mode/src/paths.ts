import os from "node:os";
import path from "node:path";

export interface LocalPathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  environmentName?: string;
  configDirOverride?: string;
  lockfileDirOverride?: string;
}

function isWindows(options: LocalPathOptions): boolean {
  return (options.platform ?? process.platform) === "win32";
}

function paths(options: LocalPathOptions): typeof path.posix {
  return isWindows(options) ? path.win32 : path.posix;
}

function home(options: LocalPathOptions): string {
  return options.homeDir ?? os.homedir();
}

export function resolveConfigHome(env: Record<string, string | undefined>, options: LocalPathOptions = {}): string {
  if (isWindows(options)) {
    return env.APPDATA?.trim() || paths(options).join(home(options), "AppData", "Roaming");
  }
  return env.XDG_CONFIG_HOME?.trim() || paths(options).join(home(options), ".config");
}

export function resolveDataHome(env: Record<string, string | undefined>, options: LocalPathOptions = {}): string {
  if (isWindows(options)) {
    return env.LOCALAPPDATA?.trim() || paths(options).join(home(options), "AppData", "Local");
  }
  return env.XDG_DATA_HOME?.trim() || paths(options).join(home(options), ".local", "share");
}

export function joinLocalPath(options: LocalPathOptions, ...segments: string[]): string {
  return paths(options).join(...segments);
}

export function assertSafePathSegment(value: string, label: string, options: LocalPathOptions = {}): void {
  const unsafe =
    !value ||
    /[/\\\0]/.test(value) ||
    /^\.{1,2}$/.test(value) ||
    (isWindows(options) &&
      (/[<>:"|?*\u0000-\u001f]/.test(value) ||
        /[. ]$/.test(value) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)));
  if (unsafe) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

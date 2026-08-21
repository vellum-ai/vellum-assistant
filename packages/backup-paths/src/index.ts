import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

export interface BackupDestination {
  path: string;
  encrypt: boolean;
}

export interface OffsitePathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function safeUserInfoHomedir(): string {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}

function resolveHomeDir(options: OffsitePathOptions): string {
  const envHome = options.env ? options.env.HOME : process.env.HOME;
  return options.homeDir || envHome || safeUserInfoHomedir() || homedir();
}

export function getICloudDriveRoot(options: OffsitePathOptions = {}): string {
  const home = resolveHomeDir(options);
  const root = posix.join(
    home,
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
  );
  if (!posix.isAbsolute(root)) {
    throw new Error(`Unable to resolve an absolute iCloud Drive path: ${root}`);
  }
  return root;
}

export function getDefaultOffsiteBackupsDir(
  options: OffsitePathOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return posix.join(
      getICloudDriveRoot(options),
      "VellumAssistant",
      "backups",
    );
  }
  // Windows can expose personal and organization-managed OneDrive roots at
  // once. An explicit destination is required to choose the intended account.
  return null;
}

export function resolveDefaultOffsiteDestinations(
  options: OffsitePathOptions = {},
): BackupDestination[] {
  const path = getDefaultOffsiteBackupsDir(options);
  return path ? [{ path, encrypt: true }] : [];
}

function isPathWithin(
  root: string,
  candidate: string,
  pathApi: typeof posix | typeof win32,
): boolean {
  const relative = pathApi.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

export function deriveSafeOffsiteAncestor(
  destinationPath: string,
  options: OffsitePathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return win32.dirname(destinationPath);
  }

  if (platform === "darwin") {
    const iCloudRoot = getICloudDriveRoot(options);
    if (isPathWithin(iCloudRoot, destinationPath, posix)) {
      return iCloudRoot;
    }

    const volumesPrefix = "/Volumes/";
    if (destinationPath.startsWith(volumesPrefix)) {
      const rest = destinationPath.slice(volumesPrefix.length);
      const slash = rest.indexOf("/");
      const volumeName = slash === -1 ? rest : rest.slice(0, slash);
      if (volumeName.length > 0) {
        return `${volumesPrefix}${volumeName}`;
      }
    }
  }

  return posix.dirname(destinationPath);
}

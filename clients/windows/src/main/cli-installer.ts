import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type CliRuntimeManifest = {
  version: string;
  bunVersion: string;
  releaseChannel?: string;
};

export interface CliRuntimePaths {
  sourceDir: string;
  installRoot: string;
  version: string;
}

type InstallState = { currentInstallDir: string; previousInstallDir?: string };

type CliRuntimeOwnership = {
  owner: "vellum-assistant";
  version: string;
};

const STATE = "install-state.json";
export const CLI_RUNTIME_OWNERSHIP_MARKER = ".vellum-runtime.json";
export const CLI_RUNTIME_EXECUTABLES = [
  "vellum.exe",
  "bun.exe",
  "assistant.exe",
  "vellum-daemon.exe",
  "vellum-gateway.exe",
  "vellum-worker.exe",
  "credential-executor.exe",
  "cli-launcher.exe",
] as const;
export const CLI_RUNTIME_ASSETS = [
  "templates",
  "bundled-skills",
  "brain-graph",
  "default-plugins",
  "first-party-skills",
  "web-dist",
  "node_modules",
  "feature-flag-registry.json",
  "web-tree-sitter.wasm",
  "tree-sitter-bash.wasm",
] as const;
export const CLI_RUNTIME_ENTRIES = [
  ...CLI_RUNTIME_EXECUTABLES,
  ...CLI_RUNTIME_ASSETS,
] as const;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function resolveCliRuntimePaths(
  userDataDir: string,
  resourcesDir: string,
  version: string,
): CliRuntimePaths {
  return {
    sourceDir: path.join(resourcesDir, "cli-runtime"),
    installRoot: path.join(userDataDir, "cli"),
    version,
  };
}

export function readRuntimeManifest(
  runtimeDir: string,
): CliRuntimeManifest | undefined {
  return readJson<CliRuntimeManifest>(path.join(runtimeDir, "runtime.json"));
}

export function isValidCliRuntime(
  runtimeDir: string,
  expectedVersion?: string,
): boolean {
  const manifest = readRuntimeManifest(runtimeDir);
  return Boolean(
    manifest?.version &&
    manifest.bunVersion &&
    (!expectedVersion || manifest.version === expectedVersion) &&
    CLI_RUNTIME_ENTRIES.every((name) =>
      existsSync(path.join(runtimeDir, name)),
    ),
  );
}

function readState(installRoot: string): InstallState | undefined {
  const state = readJson<InstallState>(path.join(installRoot, STATE));
  return typeof state?.currentInstallDir === "string" ? state : undefined;
}

function normalizeRuntimePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isDirectRuntimeDir(installRoot: string, runtimeDir: string): boolean {
  const resolvedRoot = normalizeRuntimePath(installRoot);
  const resolvedRuntime = normalizeRuntimePath(runtimeDir);
  return (
    path.dirname(resolvedRuntime) === resolvedRoot &&
    path.basename(resolvedRuntime).length > 0 &&
    !path.basename(resolvedRuntime).startsWith(".")
  );
}

function writeOwnershipMarker(runtimeDir: string, version: string): void {
  const ownership: CliRuntimeOwnership = {
    owner: "vellum-assistant",
    version,
  };
  writeFileSync(
    path.join(runtimeDir, CLI_RUNTIME_OWNERSHIP_MARKER),
    `${JSON.stringify(ownership)}\n`,
    "utf8",
  );
}

function isRealDirectory(runtimeDir: string): boolean {
  try {
    return lstatSync(runtimeDir).isDirectory();
  } catch {
    return false;
  }
}

function isOwnedCliRuntime(installRoot: string, runtimeDir: string): boolean {
  if (
    !isDirectRuntimeDir(installRoot, runtimeDir) ||
    !isRealDirectory(runtimeDir)
  ) {
    return false;
  }
  const ownership = readJson<CliRuntimeOwnership>(
    path.join(runtimeDir, CLI_RUNTIME_OWNERSHIP_MARKER),
  );
  const version = path.basename(runtimeDir);
  return (
    ownership?.owner === "vellum-assistant" &&
    ownership.version === version &&
    isValidCliRuntime(runtimeDir, version)
  );
}

function isValidInstalledRuntime(
  installRoot: string,
  runtimeDir: string | undefined,
): runtimeDir is string {
  if (!runtimeDir || !isDirectRuntimeDir(installRoot, runtimeDir)) {
    return false;
  }
  return isRealDirectory(runtimeDir) && isValidCliRuntime(runtimeDir);
}

function pruneOldCliRuntimes(
  installRoot: string,
  keepDirs: readonly string[],
): void {
  const keep = new Set(keepDirs.map(normalizeRuntimePath));
  let entries;
  try {
    entries = readdirSync(installRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const runtimeDir = path.join(installRoot, entry.name);
    if (
      !entry.isDirectory() ||
      keep.has(normalizeRuntimePath(runtimeDir)) ||
      !isOwnedCliRuntime(installRoot, runtimeDir)
    ) {
      continue;
    }
    try {
      rmSync(runtimeDir, { recursive: true });
    } catch {
      // Cleanup is best-effort and must not roll back a valid install.
    }
  }
}

function writeState(installRoot: string, state: InstallState): void {
  const target = path.join(installRoot, STATE);
  const staging = `${target}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  writeFileSync(staging, `${JSON.stringify(state)}\n`, "utf8");
  try {
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
}

export function provisionCliRuntime(paths: CliRuntimePaths) {
  const { sourceDir, installRoot, version } = paths;
  mkdirSync(installRoot, { recursive: true });
  const target = path.join(installRoot, version);
  const priorState = readState(installRoot);
  const priorCurrent = isValidInstalledRuntime(
    installRoot,
    priorState?.currentInstallDir,
  )
    ? priorState.currentInstallDir
    : undefined;
  const priorPrevious = isValidInstalledRuntime(
    installRoot,
    priorState?.previousInstallDir,
  )
    ? priorState.previousInstallDir
    : undefined;

  const selectPreviousInstallDir = (
    currentInstallDir: string,
  ): string | undefined =>
    [priorCurrent, priorPrevious].find((candidate): candidate is string =>
      Boolean(
        candidate &&
        normalizeRuntimePath(candidate) !==
          normalizeRuntimePath(currentInstallDir),
      ),
    );

  if (
    isValidInstalledRuntime(installRoot, target) &&
    isValidCliRuntime(target, version)
  ) {
    const previousInstallDir = selectPreviousInstallDir(target);
    writeOwnershipMarker(target, version);
    writeState(installRoot, {
      currentInstallDir: target,
      previousInstallDir,
    });
    pruneOldCliRuntimes(
      installRoot,
      [target, previousInstallDir].filter((dir): dir is string => Boolean(dir)),
    );
    return {
      installDir: target,
      previousInstallDir,
      reused: true,
    };
  }

  if (!isValidCliRuntime(sourceDir, version)) {
    for (const fallback of [priorCurrent, priorPrevious]) {
      if (!fallback) {
        continue;
      }
      const fallbackVersion = readRuntimeManifest(fallback)?.version;
      if (fallbackVersion) {
        writeOwnershipMarker(fallback, fallbackVersion);
      }
      return {
        installDir: fallback,
        previousInstallDir: selectPreviousInstallDir(fallback),
        reused: true,
      };
    }
    throw new Error("The packaged Windows CLI runtime is missing or invalid.");
  }

  const staging = path.join(installRoot, `.${version}.${process.pid}.staging`);
  const displaced = path.join(
    installRoot,
    `.${version}.${process.pid}.replaced`,
  );
  rmSync(staging, { recursive: true, force: true });
  rmSync(displaced, { recursive: true, force: true });
  let installedTarget = false;
  try {
    cpSync(sourceDir, staging, { recursive: true, errorOnExist: true });
    if (!isValidCliRuntime(staging, version)) {
      throw new Error("The staged Windows CLI runtime failed validation.");
    }
    writeOwnershipMarker(staging, version);
    if (existsSync(target)) {
      renameSync(target, displaced);
    }
    renameSync(staging, target);
    installedTarget = true;
    const previousInstallDir = selectPreviousInstallDir(target);
    writeState(installRoot, {
      currentInstallDir: target,
      previousInstallDir,
    });
    rmSync(displaced, { recursive: true, force: true });
    pruneOldCliRuntimes(
      installRoot,
      [target, previousInstallDir].filter((dir): dir is string => Boolean(dir)),
    );
    return {
      installDir: target,
      previousInstallDir,
      reused: false,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (installedTarget) {
      rmSync(target, { recursive: true, force: true });
    }
    if (existsSync(displaced)) {
      renameSync(displaced, target);
    }
    throw error;
  }
}

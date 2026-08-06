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

type CliRuntimeManifest = { version: string; bunVersion: string };

export interface CliRuntimePaths {
  sourceDir: string;
  installRoot: string;
  version: string;
}

type InstallState = { currentInstallDir: string; previousInstallDir?: string };

const STATE = "install-state.json";

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
    existsSync(path.join(runtimeDir, "vellum.exe")) &&
    existsSync(path.join(runtimeDir, "bun.exe")),
  );
}

function readState(installRoot: string): InstallState | undefined {
  const state = readJson<InstallState>(path.join(installRoot, STATE));
  return typeof state?.currentInstallDir === "string" ? state : undefined;
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

  if (isValidCliRuntime(target, version)) {
    writeState(installRoot, {
      currentInstallDir: target,
      previousInstallDir: priorState?.previousInstallDir,
    });
    return {
      installDir: target,
      previousInstallDir: priorState?.previousInstallDir,
      reused: true,
    };
  }

  if (!isValidCliRuntime(sourceDir, version)) {
    for (const fallback of [
      priorState?.currentInstallDir,
      priorState?.previousInstallDir,
    ]) {
      if (fallback && isValidCliRuntime(fallback)) {
        return {
          installDir: fallback,
          previousInstallDir: priorState?.previousInstallDir,
          reused: true,
        };
      }
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
    if (existsSync(target)) {
      renameSync(target, displaced);
    }
    renameSync(staging, target);
    installedTarget = true;
    writeState(installRoot, {
      currentInstallDir: target,
      previousInstallDir:
        priorState && isValidCliRuntime(priorState.currentInstallDir)
          ? priorState.currentInstallDir
          : priorState?.previousInstallDir,
    });
    rmSync(displaced, { recursive: true, force: true });
    return {
      installDir: target,
      previousInstallDir: priorState?.currentInstallDir,
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

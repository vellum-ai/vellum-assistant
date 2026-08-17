import path from "node:path";

import { readRuntimeManifest } from "../src/main/cli-installer";
import {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "../src/main/cli-path-installer";

export function uninstallPackagedCli(
  execPath: string,
  localAppData: string,
  uninstallLauncher: typeof uninstallCliLauncher = uninstallCliLauncher,
): void {
  const runtimeDir = path.dirname(execPath);
  const releaseChannel =
    readRuntimeManifest(runtimeDir)?.releaseChannel ?? "production";
  const result = uninstallLauncher(
    resolveCliLauncherPaths(localAppData, releaseChannel),
    undefined,
    path.dirname(runtimeDir),
  );
  if (result === "blocked") {
    throw new Error(
      "Unable to remove the Vellum command launcher. Close active vellum commands and try again.",
    );
  }
}

if (import.meta.main) {
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error(
        "LOCALAPPDATA is unavailable. Retry uninstalling Vellum.",
      );
    }
    uninstallPackagedCli(process.execPath, localAppData);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

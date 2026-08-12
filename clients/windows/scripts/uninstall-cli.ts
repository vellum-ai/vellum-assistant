import path from "node:path";

import { readRuntimeManifest } from "../src/main/cli-installer";
import {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "../src/main/cli-path-installer";

const localAppData = process.env.LOCALAPPDATA;
if (localAppData) {
  const runtimeDir = path.dirname(process.execPath);
  const releaseChannel =
    readRuntimeManifest(runtimeDir)?.releaseChannel ?? "production";
  uninstallCliLauncher(
    resolveCliLauncherPaths(localAppData, releaseChannel),
    undefined,
    path.dirname(runtimeDir),
  );
}

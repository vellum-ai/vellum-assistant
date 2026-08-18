import path from "node:path";

import { provisionCliRuntime, resolveCliRuntimePaths } from "./cli-installer";
import {
  installCliLauncher,
  resolveCliLauncherPaths,
  type RegistryRunner,
} from "./cli-path-installer";

export interface CliPathFlowOptions {
  userDataDir: string;
  resourcesDir: string;
  localAppData: string;
  releaseChannel: string;
  version: string;
  registryRunner?: RegistryRunner;
}

export function provisionCliForCurrentUser(options: CliPathFlowOptions) {
  const {
    userDataDir,
    resourcesDir,
    localAppData,
    releaseChannel,
    version,
    registryRunner,
  } = options;
  const runtime = provisionCliRuntime(
    resolveCliRuntimePaths(userDataDir, resourcesDir, version),
  );
  const sourcePath = path.join(runtime.installDir, "vellum.exe");
  const launcherState = installCliLauncher(
    sourcePath,
    version,
    resolveCliLauncherPaths(localAppData, releaseChannel),
    registryRunner,
    { ownerId: resourcesDir },
  );
  return {
    installDir: runtime.installDir,
    launcherState,
    reusedRuntime: runtime.reused,
  };
}

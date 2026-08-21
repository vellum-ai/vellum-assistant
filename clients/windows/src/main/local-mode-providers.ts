import { app } from "electron";
import path from "node:path";

import {
  bundleHostProviderToken,
  resolveActiveBundleGateway,
} from "@vellumai/electron-desktop/bundle-platform";
import type { DesktopCapabilityRegistry } from "@vellumai/electron-desktop/capability-registry";
import {
  configureLocalMode,
  getLocalGuardianAccessToken,
  LOCAL_MODE_CLI,
  LOCAL_MODE_PATHS,
  LOCAL_MODE_SESSION,
} from "@vellumai/electron-desktop/local-mode";
import { refreshLockfileNow } from "@vellumai/electron-desktop/lockfile-watcher";
import { denyAllPermissions } from "@vellumai/electron-desktop/permissions";
import { getSessionToken } from "@vellumai/electron-desktop/session-token-store";
import {
  resolveConfigDir,
  resolveDevCliInvocation,
  resolveEnvironmentName,
  resolveLockfilePaths,
  type CliInvocation,
} from "@vellumai/local-mode";

import { provisionCliRuntime, resolveCliRuntimePaths } from "./cli-installer";
import { handle } from "./ipc.client";

const resolveCliInvocation = async (): Promise<CliInvocation> => {
  const override = process.env.VELLUM_CLI_PATH;
  if (override) {
    return { command: "bun", baseArgs: ["run", override] };
  }

  if (!app.isPackaged) {
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    try {
      return resolveDevCliInvocation(repoRoot, import.meta.url);
    } catch {
      // Fall through to the packaged runtime.
    }
  }

  const runtime = provisionCliRuntime(
    resolveCliRuntimePaths(
      app.getPath("userData"),
      process.resourcesPath,
      app.getVersion(),
    ),
  );
  return {
    command: path.join(runtime.installDir, "vellum.exe"),
    baseArgs: [],
  };
};

export const installWindowsLocalModeProviders = (
  registry: DesktopCapabilityRegistry,
): void => {
  const cli = { resolveInvocation: resolveCliInvocation };
  const paths = {
    configDir: resolveConfigDir(process.env),
    environment: resolveEnvironmentName(process.env),
    lockfilePaths: resolveLockfilePaths(process.env),
  };
  const session = { getToken: getSessionToken };

  registry.provide(LOCAL_MODE_CLI, cli);
  registry.provide(LOCAL_MODE_PATHS, paths);
  registry.provide(LOCAL_MODE_SESSION, session);
  registry.provide(bundleHostProviderToken, {
    resolveActiveGateway: () => resolveActiveBundleGateway(paths.lockfilePaths),
    acquireGatewayToken: async (assistantId) => {
      const result = await getLocalGuardianAccessToken(assistantId);
      return result.ok ? result.accessToken : null;
    },
    denyAllPermissions,
  });

  configureLocalMode({
    cli,
    handle,
    paths,
    refreshLockfile: refreshLockfileNow,
    session,
  });
};

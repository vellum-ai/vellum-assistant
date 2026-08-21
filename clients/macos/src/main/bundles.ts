import { app } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  configureBundlePlatform,
  resolveActiveBundleGateway,
} from "@vellumai/electron-desktop/bundle-platform";
import { denyAllPermissions } from "@vellumai/electron-desktop/permissions";
import {
  handleBundleFile,
  installBundleFlow,
} from "@vellumai/electron-desktop/bundle-flow";
import {
  getGuardianAccessToken,
  resolveConfigDir,
  resolveLockfilePaths,
} from "@vellumai/local-mode";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { handle, on } from "./ipc";
import { resolveCliInvocation } from "./local-mode.client";

const acquireGatewayToken = async (
  assistantId: string,
): Promise<string | null> => {
  try {
    const invocation = await resolveCliInvocation();
    const result = await getGuardianAccessToken(
      assistantId,
      resolveConfigDir(process.env),
      invocation,
      true,
    );
    return result.ok ? result.accessToken : null;
  } catch {
    return null;
  }
};

export const installMacBundleWorkflow = (): void => {
  configureBundlePlatform({
    resolveActiveGateway: () =>
      resolveActiveBundleGateway(resolveLockfilePaths(process.env)),
    acquireGatewayToken,
    bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    rendererBase: () =>
      app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
    denyAllPermissions,
    ipc: { handle, on },
  });
  installBundleFlow();
};

export { handleBundleFile };

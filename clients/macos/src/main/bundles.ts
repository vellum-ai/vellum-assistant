import { app } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  configureBundlePlatform,
} from "@vellumai/electron-desktop/bundle-platform";
import {
  handleBundleFile,
  installBundleFlow,
} from "@vellumai/electron-desktop/bundle-flow";
import { createBundleHostProvider } from "@vellumai/electron-desktop/bundle-host";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { handle, on } from "./ipc";
import { resolveCliInvocation } from "./local-mode.client";

export const installMacBundleWorkflow = (): void => {
  configureBundlePlatform({
    ...createBundleHostProvider(resolveCliInvocation),
    bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    rendererBase: () =>
      app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
    ipc: { handle, on },
  });
  installBundleFlow();
};

export { handleBundleFile };

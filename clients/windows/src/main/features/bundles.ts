import { app } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  bundleFileHandlerToken,
  bundleHostProviderToken,
  configureBundlePlatform,
} from "@vellumai/electron-desktop/bundle-platform";
import {
  handleBundleFile,
  installBundleFlow,
} from "@vellumai/electron-desktop/bundle-flow";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { onFileOpen } from "@vellumai/electron-desktop/file-open";

import { getRendererBase } from "../app-config";
import { handle, on } from "../ipc.client";

const bundles: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "windows.bundles",
  install(registry) {
    const host = registry.get(bundleHostProviderToken);
    if (!host) {
      return;
    }

    configureBundlePlatform({
      ...host,
      bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
      rendererBase: () => getRendererBase(app.isPackaged),
      ipc: { handle, on },
    });
    installBundleFlow();
    registry.provide(bundleFileHandlerToken, handleBundleFile);
    const stopFileOpen = onFileOpen((filePath) => {
      void handleBundleFile(filePath);
    });
    app.once("before-quit", stopFileOpen);
  },
};

export default bundles;

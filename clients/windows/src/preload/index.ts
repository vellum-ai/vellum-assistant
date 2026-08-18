import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  AppVersionInfo,
  VellumBridge,
  VellumCommand,
} from "@vellumai/ipc-contract";

import type { WindowsCoreBridge } from "./core-capabilities";
import { composePreloadFeatures } from "./features";

export type { AppVersionInfo, VellumBridge, VellumCommand };

/**
 * Minimal subset of the `VellumBridge` contract for the Windows skeleton.
 *
 * Most of the renderer's runtime wrappers (`clients/web/src/runtime/`)
 * feature-detect their namespace (`if (!bridge?.hotkeys) return ...`) so a
 * newer renderer can run against an older - or, here, narrower - preload.
 * Capabilities that are dereferenced unguarded live in this core bridge or
 * are installed through the feature modules below.
 */
const coreBridge: WindowsCoreBridge = {
  platform: "electron",
  hostOS: "windows",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("vellum:app:versionInfo") as Promise<AppVersionInfo>,
    openWebsite: (): Promise<void> =>
      ipcRenderer.invoke("vellum:app:openWebsite") as Promise<void>,
  },
  commands: {
    on: (callback) => {
      const handler = (_event: IpcRendererEvent, command: VellumCommand) => {
        callback(command);
      };
      ipcRenderer.on("vellum:command", handler);
      return () => {
        ipcRenderer.off("vellum:command", handler);
      };
    },
  },
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      ipcRenderer.invoke("vellum:mainWindow:ensureVisible") as Promise<void>,
    setOnboarding: (active: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:mainWindow:setOnboarding",
        active,
      ) as Promise<void>,
  },
};

const bridge = composePreloadFeatures(coreBridge);
contextBridge.exposeInMainWorld("vellum", bridge);

const vellumConfig = ipcRenderer.sendSync("vellum:config:get") as {
  webUrl: string;
  platformUrl: string;
  disablePlatform?: boolean;
  deviceId: string | null;
} | null;
if (vellumConfig) {
  contextBridge.exposeInMainWorld("__VELLUM_CONFIG__", vellumConfig);
}

const flagOverrides: Record<string, boolean | string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("VELLUM_FLAG_") || value === undefined) {
    continue;
  }
  const flagKey = key
    .slice("VELLUM_FLAG_".length)
    .toLowerCase()
    .replace(/_/g, "-");
  const lower = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) {
    flagOverrides[flagKey] = true;
  } else if (["false", "0", "no", "off"].includes(lower)) {
    flagOverrides[flagKey] = false;
  } else {
    flagOverrides[flagKey] = value.trim();
  }
}
if (Object.keys(flagOverrides).length > 0) {
  contextBridge.exposeInMainWorld("__VELLUM_FLAG_OVERRIDES__", flagOverrides);
}

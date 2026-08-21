import { contextBridge, ipcRenderer } from "electron";

import type {
  AppVersionInfo,
  VellumBridge,
  VellumCommand,
} from "@vellumai/ipc-contract";

import { createWindowsCoreBridge } from "./core-capabilities";
import { composePreloadFeatures } from "./features";

export type { AppVersionInfo, VellumBridge, VellumCommand };

// The always-present core plus every `./features/` module;
// `bridge-parity.test.ts` holds the composed bridge to the full contract.
const bridge = composePreloadFeatures(createWindowsCoreBridge(ipcRenderer));
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

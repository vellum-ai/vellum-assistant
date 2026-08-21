import type { Session } from "electron";

import { capabilityToken } from "./capability-registry";
import type { IpcRegistrar } from "./ipc";

export const BUNDLES_DIR_NAME = "bundles";
export const VELLUMAPP_PROTOCOL = "vellumapp";

export interface ActiveBundleGateway {
  assistantId: string;
  port: number;
}

export interface BundleHostProvider {
  resolveActiveGateway: () => ActiveBundleGateway | null;
  acquireGatewayToken: (assistantId: string) => Promise<string | null>;
  denyAllPermissions: (targetSession: Session) => void;
}

export const bundleFileHandlerToken = capabilityToken<
  (filePath: string) => Promise<void>
>("desktop.bundle-file-handler");

export interface BundlePlatform extends BundleHostProvider {
  bundlesRoot: () => string;
  ipc: Pick<IpcRegistrar, "handle" | "on">;
  rendererBase: () => string;
}

let platform: BundlePlatform | undefined;

export const configureBundlePlatform = (value: BundlePlatform): void => {
  if (platform) {
    throw new Error("Bundle platform is already configured");
  }
  platform = value;
};

export const getBundlePlatform = (): BundlePlatform => {
  if (!platform) {
    throw new Error("Bundle platform is not configured");
  }
  return platform;
};

export const resetBundlePlatformForTest = (): void => {
  platform = undefined;
};

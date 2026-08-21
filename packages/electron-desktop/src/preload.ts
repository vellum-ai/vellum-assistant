import type { IpcRenderer, IpcRendererEvent } from "electron";

import {
  BUNDLE_CONFIRM_GET_DATA,
  BUNDLE_CONFIRM_RESPOND,
  type BundleScanData,
  type DeepLink,
  type VellumBridge,
} from "@vellumai/ipc-contract";

type RendererIpc = Pick<IpcRenderer, "invoke" | "off" | "on" | "send">;

export const createDeepLinksBridge = (
  ipc: RendererIpc,
): VellumBridge["deepLinks"] => ({
  drain: () => ipc.invoke("vellum:deepLinks:drain") as Promise<DeepLink[]>,
  onLink: (callback) => {
    const handler = (_event: IpcRendererEvent, link: DeepLink): void => {
      callback(link);
    };
    ipc.on("vellum:deepLinks:event", handler);
    ipc.send("vellum:deepLinks:subscribe");
    return () => {
      ipc.off("vellum:deepLinks:event", handler);
      ipc.send("vellum:deepLinks:unsubscribe");
    };
  },
});

export const createLaunchAtLoginBridge = (
  ipc: RendererIpc,
): VellumBridge["launchAtLogin"] => ({
  get: () => ipc.invoke("vellum:launchAtLogin:get") as Promise<boolean>,
  set: (enabled) =>
    ipc.invoke("vellum:launchAtLogin:set", enabled) as Promise<void>,
});

export const createBundleConfirmationBridge = (
  ipc: RendererIpc,
): VellumBridge["bundleConfirm"] => ({
  getData: () =>
    ipc.invoke(BUNDLE_CONFIRM_GET_DATA) as Promise<BundleScanData | null>,
  respond: (accepted) => {
    ipc.send(BUNDLE_CONFIRM_RESPOND, accepted);
  },
});

import type { IpcRenderer, IpcRendererEvent } from "electron";

import type {
  BundleScanData,
  DeepLink,
  DownloadDoneEvent,
  ResolvedHotkey,
  UpdateState,
  VellumBridge,
} from "@vellumai/ipc-contract";
import { DOWNLOADS_DONE_EVENT, DOWNLOADS_REVEAL } from "@vellumai/ipc-contract";

type RendererIpc = Pick<IpcRenderer, "invoke" | "off" | "on" | "send">;

const subscribe =
  <Payload>(ipc: RendererIpc, channel: string) =>
  (callback: (payload: Payload) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: Payload): void => {
      callback(payload);
    };
    ipc.on(channel, handler);
    return () => {
      ipc.off(channel, handler);
    };
  };

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

/** Renderer side of `installHotkeysIpc`. */
export const createHotkeysBridge = (
  ipc: RendererIpc,
): VellumBridge["hotkeys"] => ({
  get: () => ipc.invoke("vellum:hotkeys:get") as Promise<ResolvedHotkey[]>,
  set: (key, accelerator) =>
    ipc.invoke("vellum:hotkeys:set", key, accelerator) as Promise<void>,
  onChange: subscribe<ResolvedHotkey[]>(ipc, "vellum:hotkeys:changed"),
});

/** Renderer side of `installBundleConfirmation`. */
export const createBundleConfirmBridge = (
  ipc: RendererIpc,
): VellumBridge["bundleConfirm"] => ({
  getData: () =>
    ipc.invoke(
      "vellum:bundleConfirm:getData",
    ) as Promise<BundleScanData | null>,
  respond: (accepted) => {
    ipc.send("vellum:bundleConfirm:respond", accepted);
  },
});

/** Renderer side of `installDownloads`. */
export const createDownloadsBridge = (
  ipc: RendererIpc,
): VellumBridge["downloads"] => ({
  onDone: subscribe<DownloadDoneEvent>(ipc, DOWNLOADS_DONE_EVENT),
  reveal: (id) => ipc.invoke(DOWNLOADS_REVEAL, id),
});

/** Renderer side of `installAutoUpdate`. */
export const createUpdateBridge = (
  ipc: RendererIpc,
): VellumBridge["update"] => ({
  getState: () => ipc.invoke("vellum:update:getState") as Promise<UpdateState>,
  check: () => ipc.invoke("vellum:update:check") as Promise<void>,
  install: () => ipc.invoke("vellum:update:install") as Promise<void>,
  onState: subscribe<UpdateState>(ipc, "vellum:update:state"),
});

import type { IpcRenderer, IpcRendererEvent } from "electron";

import type {
  BundleScanData,
  DeepLink,
  DownloadDoneEvent,
  ResolvedHotkey,
  UpdateState,
  VellumBridge,
  WindowAttentionPayload,
} from "@vellumai/ipc-contract";
import {
  DOWNLOADS_DONE_EVENT,
  DOWNLOADS_REVEAL,
  WINDOW_ATTENTION,
} from "@vellumai/ipc-contract";

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

/**
 * Like {@link subscribe}, but the IPC listener is installed once when the
 * factory runs and the latest payload is replayed to each callback as it
 * registers.
 *
 * Push-only channels whose first payload arrives on page load need this: the
 * preload evaluates ahead of every page script, so the listener below is in
 * place for that payload, while the renderer callbacks are React effects and
 * lazy routes that register afterwards. Without the replay such a callback
 * holds its default until the next transition on the channel.
 */
const subscribeWithReplay = <Payload>(
  ipc: RendererIpc,
  channel: string,
): ((callback: (payload: Payload) => void) => () => void) => {
  const callbacks = new Set<(payload: Payload) => void>();
  let latest: { payload: Payload } | null = null;
  ipc.on(channel, (_event: IpcRendererEvent, payload: Payload): void => {
    latest = { payload };
    // Snapshot so a callback that subscribes mid-dispatch is served by its own
    // replay instead of twice, and re-check membership so one that
    // unsubscribes mid-dispatch is not called after the fact.
    for (const callback of [...callbacks]) {
      if (!callbacks.has(callback)) {
        continue;
      }
      callback(payload);
    }
  });
  return (callback) => {
    callbacks.add(callback);
    if (latest) {
      // Synchronous, so the replay always lands before the caller holds the
      // unsubscribe function and can never outlive it.
      callback(latest.payload);
    }
    return () => {
      callbacks.delete(callback);
    };
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

/** Renderer side of `installWindowAttention`. */
export const createWindowAttentionSubscriber = (
  ipc: RendererIpc,
): VellumBridge["notifications"]["onWindowAttention"] =>
  subscribeWithReplay<WindowAttentionPayload>(ipc, WINDOW_ATTENTION);

import type { IpcRenderer, IpcRendererEvent } from "electron";

import type {
  AppVersionInfo,
  VellumBridge,
  VellumCommand,
} from "@vellumai/ipc-contract";

export const LINUX_CORE_CAPABILITIES = [
  "platform",
  "hostOS",
  "app",
  "commands",
  "mainWindow",
] as const satisfies readonly (keyof VellumBridge)[];

export type LinuxCoreBridge = Pick<
  VellumBridge,
  (typeof LINUX_CORE_CAPABILITIES)[number]
>;

/**
 * macOS-only companion surfaces with no Linux counterpart. The renderer
 * feature-detects them and falls back to web behavior.
 */
export const LINUX_NOT_APPLICABLE_CAPABILITIES = [
  "companion",
  "voiceActivity",
] as const satisfies readonly (keyof VellumBridge)[];

/** The always-present core every `./features/` module builds on. */
export const createLinuxCoreBridge = (
  ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "off">,
): LinuxCoreBridge => ({
  platform: "electron",
  hostOS: "linux",
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
});

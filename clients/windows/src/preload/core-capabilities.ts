import type { IpcRenderer, IpcRendererEvent } from "electron";

import type {
  AppVersionInfo,
  TitleBarOverlayTheme,
  VellumBridge,
  VellumCommand,
} from "@vellumai/ipc-contract";

export const WINDOWS_CORE_CAPABILITIES = [
  "platform",
  "hostOS",
  "app",
  "commands",
  "mainWindow",
] as const satisfies readonly (keyof VellumBridge)[];

export type WindowsCoreBridge = Pick<
  VellumBridge,
  (typeof WINDOWS_CORE_CAPABILITIES)[number]
>;

/**
 * macOS-only bridge surfaces with no Windows counterpart. Both belong to the
 * companion surface, a floating always-present window the Windows shell does
 * not open; the renderer feature-detects them and falls back to web behavior.
 * See `docs/parity-matrix.md`.
 */
export const WINDOWS_NOT_APPLICABLE_CAPABILITIES = [
  "companion",
  "voiceActivity",
] as const satisfies readonly (keyof VellumBridge)[];

/** The always-present core every `./features/` module builds on. */
export const createWindowsCoreBridge = (
  ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "off">,
): WindowsCoreBridge => ({
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
    setTitleBarOverlay: (theme: TitleBarOverlayTheme): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:mainWindow:setTitleBarOverlay",
        theme,
      ) as Promise<void>,
  },
});

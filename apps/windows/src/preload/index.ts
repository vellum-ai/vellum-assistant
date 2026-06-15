import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { Lockfile } from "@vellumai/local-mode";
import type {
  AppVersionInfo,
  VellumBridge,
  VellumCommand,
} from "@vellumai/ipc-contract";

export type { AppVersionInfo, VellumBridge, VellumCommand };

const NOT_AVAILABLE = "Local mode is not available on the Windows client yet";

const noopUnsubscribe = (): (() => void) => () => undefined;

/**
 * Minimal subset of the `VellumBridge` contract for the Windows skeleton.
 *
 * Most of the renderer's runtime wrappers (`apps/web/src/runtime/`)
 * feature-detect their namespace (`if (!bridge?.hotkeys) return ...`) so a
 * newer renderer can run against an older — or, here, narrower — preload.
 * But a handful are treated as required the moment `platform` reads
 * `"electron"` and are dereferenced unguarded (`window.vellum?.power.onEvent`,
 * `window.vellum!.localMode.*`, dock, menu, mainWindow, deepLinks), so those
 * ship as explicit no-op stubs rather than being absent. Each capability
 * ported from the macOS client (`apps/macos/src/preload/index.ts`) should
 * replace its stub with the real IPC wiring alongside its main-process
 * handlers.
 */
const bridge: Pick<
  VellumBridge,
  | "platform"
  | "app"
  | "commands"
  | "power"
  | "deepLinks"
  | "dock"
  | "menu"
  | "mainWindow"
  | "localMode"
> = {
  platform: "electron",
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
  // Stub: no power events until `apps/macos/src/main/power-events.ts` is
  // ported. The subscription never fires; the unsubscribe is a no-op.
  power: {
    onEvent: noopUnsubscribe,
  },
  // Stub: deep links need `vellum://` protocol registration plus
  // second-instance argv parsing (`apps/macos/src/main/deep-links.ts`).
  deepLinks: {
    drain: () => Promise.resolve([]),
    onLink: noopUnsubscribe,
  },
  // Stub: the Windows analogue is a taskbar overlay icon
  // (`win.setOverlayIcon`), not a dock badge.
  dock: {
    setBadge: () => undefined,
    setSignedIn: () => undefined,
  },
  // Stub: no application menu yet (`apps/macos/src/main/menu.ts`).
  menu: {
    setPlatformSession: () => Promise.resolve(),
  },
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      ipcRenderer.invoke("vellum:mainWindow:ensureVisible") as Promise<void>,
    // Stub: onboarding window sizing needs the window-state port
    // (`apps/macos/src/main/window-state.ts`).
    setOnboarding: () => Promise.resolve(),
  },
  // Stub: local assistants need the CLI provisioning + lockfile IPC port
  // (`apps/macos/src/main/local-mode.ts`). The empty lockfile renders an
  // empty assistant list; mutations report a structured failure the
  // renderer already surfaces by message.
  localMode: {
    hatch: () => Promise.resolve({ ok: false, error: NOT_AVAILABLE }),
    readLockfile: (): Promise<Lockfile> =>
      Promise.resolve({ assistants: [], activeAssistant: null }),
    saveLockfileAssistant: () =>
      Promise.resolve({ ok: false as const, error: NOT_AVAILABLE }),
    replacePlatformAssistants: () =>
      Promise.resolve({ ok: false as const, error: NOT_AVAILABLE }),
    wake: () => Promise.resolve({ ok: false, error: NOT_AVAILABLE }),
    retire: () => Promise.resolve({ ok: false, error: NOT_AVAILABLE }),
    guardianToken: () =>
      Promise.resolve({ ok: false as const, status: 501, error: NOT_AVAILABLE }),
  },
};

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
  if (!key.startsWith("VELLUM_FLAG_") || value === undefined) continue;
  const flagKey = key
    .slice("VELLUM_FLAG_".length)
    .toLowerCase()
    .replace(/_/g, "-");
  const lower = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) flagOverrides[flagKey] = true;
  else if (["false", "0", "no", "off"].includes(lower))
    flagOverrides[flagKey] = false;
  else flagOverrides[flagKey] = value.trim();
}
if (Object.keys(flagOverrides).length > 0) {
  contextBridge.exposeInMainWorld("__VELLUM_FLAG_OVERRIDES__", flagOverrides);
}

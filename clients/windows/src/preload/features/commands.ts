import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import type { ResolvedHotkey, VellumBridge } from "@vellumai/ipc-contract";

const commandsFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "commands",
  install: (registry) => {
    registry.contribute("hotkeys", {
      get: () =>
        ipcRenderer.invoke("vellum:hotkeys:get") as Promise<ResolvedHotkey[]>,
      set: (key, accelerator) =>
        ipcRenderer.invoke("vellum:hotkeys:set", key, accelerator) as Promise<void>,
      onChange: (callback) => {
        const handler = (
          _event: IpcRendererEvent,
          catalog: ResolvedHotkey[],
        ): void => {
          callback(catalog);
        };
        ipcRenderer.on("vellum:hotkeys:changed", handler);
        return () => {
          ipcRenderer.off("vellum:hotkeys:changed", handler);
        };
      },
    });
    registry.contribute("menu", {
      setPlatformSession: (has) =>
        ipcRenderer.invoke("vellum:menu:setPlatformSession", has) as Promise<void>,
    });
  },
};

export default commandsFeature;

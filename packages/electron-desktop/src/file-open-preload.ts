import {
  FILE_OPEN_DRAIN,
  FILE_OPEN_EVENT,
  FILE_OPEN_SUBSCRIBE,
  FILE_OPEN_UNSUBSCRIBE,
  type VellumBridge,
} from "@vellumai/ipc-contract";

export interface FileOpenPreloadDependencies {
  ipcRenderer: Pick<
    typeof import("electron").ipcRenderer,
    "invoke" | "send" | "on" | "off"
  >;
  webUtils: Pick<typeof import("electron").webUtils, "getPathForFile">;
}

export const createFileOpenPreloadBridge = ({
  ipcRenderer,
  webUtils,
}: FileOpenPreloadDependencies): Pick<VellumBridge, "fileOpen" | "paths"> => ({
  fileOpen: {
    drain: () => ipcRenderer.invoke(FILE_OPEN_DRAIN) as Promise<string[]>,
    onFile: (callback) => {
      ipcRenderer.send(FILE_OPEN_SUBSCRIBE);
      const handler = (
        _event: Electron.IpcRendererEvent,
        filePath: string,
      ): void => {
        callback(filePath);
      };
      ipcRenderer.on(FILE_OPEN_EVENT, handler);
      return () => {
        ipcRenderer.send(FILE_OPEN_UNSUBSCRIBE);
        ipcRenderer.off(FILE_OPEN_EVENT, handler);
      };
    },
  },
  paths: {
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
  },
});

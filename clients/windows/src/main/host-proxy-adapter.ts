import { hostname } from "node:os";

import { app } from "electron";

import {
  createHostProxyClientHeaders,
  type HostProxyRuntime,
} from "@vellumai/electron-desktop/host-proxy/router";
import { HostBrowserExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-browser-executor";
import { hostFileExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-file-executor";
import { hostTransferExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-transfer-executor";
import { createHostUiSnapshotExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-ui-snapshot-executor";

import { getRendererBase } from "./app-config";
import { hostBashExecutor } from "./executors/host-bash-adapter";

import type { ComputerUseActionExecutors } from "./features/computer-use-actions";

export type WindowsHostProxySources = Omit<
  HostProxyRuntime,
  "executors" | "teardownExecutors" | "posterClientHeaders" | "sseClientHeaders"
> & {
  getClientId: () => string;
  /**
   * Native input executors contributed by the `computer-use-actions`
   * capability module. Absent when the native helper feature is not installed.
   */
  computerUseExecutors?: ComputerUseActionExecutors;
};

export const createWindowsHostProxyRuntime = (
  sources: WindowsHostProxySources,
): HostProxyRuntime => {
  const { getClientId, computerUseExecutors, ...runtimeSources } = sources;
  const browserExecutor = new HostBrowserExecutor();
  const executors = {
    host_bash: hostBashExecutor,
    host_file: hostFileExecutor,
    host_transfer: hostTransferExecutor,
    host_browser: browserExecutor,
    host_ui_snapshot: createHostUiSnapshotExecutor({
      resolveRendererBase: () => getRendererBase(app.isPackaged),
    }),
    ...(computerUseExecutors
      ? {
          host_cu: computerUseExecutors.host_cu,
        }
      : {}),
  };
  const clientHeaders = createHostProxyClientHeaders({
    getClientId,
    getMachineName: hostname,
    interfaceId: "windows",
  });
  const sseClientHeaders = () => ({
    ...clientHeaders.sseClientHeaders(),
    "X-Vellum-Host-Capabilities": Object.keys(executors).join(","),
  });
  return {
    ...runtimeSources,
    ...clientHeaders,
    sseClientHeaders,
    sseFallbackClientHeaders: () => ({
      ...sseClientHeaders(),
      "X-Vellum-Interface-Id": "macos",
    }),
    executors,
    teardownExecutors: () => {
      browserExecutor.destroy();
      computerUseExecutors?.teardown();
    },
  };
};

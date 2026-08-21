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
   * Computer-use executors contributed by the `computer-use-actions` capability
   * module. Absent when the native helper feature is not installed, in which
   * case `host_cu` is reported as unavailable to the daemon.
   */
  computerUseExecutors?: ComputerUseActionExecutors;
};

export const createWindowsHostProxyRuntime = (
  sources: WindowsHostProxySources,
): HostProxyRuntime => {
  const { getClientId, computerUseExecutors, ...runtimeSources } = sources;
  const browserExecutor = new HostBrowserExecutor();
  const clientHeaders = createHostProxyClientHeaders({
    getClientId,
    getMachineName: hostname,
    interfaceId: "windows",
  });
  return {
    ...runtimeSources,
    ...clientHeaders,
    sseFallbackClientHeaders: () => ({
      ...clientHeaders.sseClientHeaders(),
      "X-Vellum-Interface-Id": "macos",
    }),
    executors: {
      host_bash: hostBashExecutor,
      host_file: hostFileExecutor,
      host_transfer: hostTransferExecutor,
      host_browser: browserExecutor,
      host_ui_snapshot: createHostUiSnapshotExecutor({
        resolveRendererBase: () => getRendererBase(app.isPackaged),
      }),
      ...(computerUseExecutors
        ? { host_cu: computerUseExecutors.host_cu }
        : {}),
    },
    teardownExecutors: () => {
      browserExecutor.destroy();
      computerUseExecutors?.teardown();
    },
  };
};

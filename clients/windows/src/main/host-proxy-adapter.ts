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

import { getDevRendererBase, RENDERER_BASE_PROD } from "./app-config";
import { hostBashExecutor } from "./executors/host-bash-adapter";

export type WindowsHostProxySources = Omit<
  HostProxyRuntime,
  "executors" | "teardownExecutors" | "posterClientHeaders" | "sseClientHeaders"
> & {
  getClientId: () => string;
};

export const createWindowsHostProxyRuntime = (
  sources: WindowsHostProxySources,
): HostProxyRuntime => {
  const { getClientId, ...runtimeSources } = sources;
  const browserExecutor = new HostBrowserExecutor();
  return {
    ...runtimeSources,
    ...createHostProxyClientHeaders({
      getClientId,
      getMachineName: hostname,
      interfaceId: "windows",
    }),
    // Only the portable committed executor kinds; host_cu and
    // host_app_control wait on their Windows capability providers.
    executors: {
      host_bash: hostBashExecutor,
      host_file: hostFileExecutor,
      host_transfer: hostTransferExecutor,
      host_browser: browserExecutor,
      host_ui_snapshot: createHostUiSnapshotExecutor({
        resolveRendererBase: () =>
          app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
      }),
    },
    teardownExecutors: () => {
      browserExecutor.destroy();
    },
  };
};

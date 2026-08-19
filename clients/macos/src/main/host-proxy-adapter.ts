import { hostname } from "node:os";

import {
  createHostProxyClientHeaders,
  installHostProxyBridge as installSharedHostProxyBridge,
  type HostProxyRuntime,
} from "@vellumai/electron-desktop/host-proxy/router";
import { getDeviceId } from "@vellumai/electron-desktop/device-id";
import {
  getGuardianAccessToken,
  resolveConfigDir,
  resolveEnvironmentName,
  type CliInvocation,
} from "@vellumai/local-mode";

import { app } from "electron";

import { HostBrowserExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-browser-executor";
import { hostFileExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-file-executor";
import { hostTransferExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-transfer-executor";
import { createHostUiSnapshotExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-ui-snapshot-executor";

import { getDevRendererBase, RENDERER_BASE_PROD } from "./app-config";
import { hostAppControlExecutor } from "./executors/host-app-control-executor";
import { hostBashExecutor } from "./executors/host-bash-adapter";
import { hostCuExecutor } from "./executors/host-cu-executor";
import {
  getWatchedLockfile,
  onLockfileChange,
} from "./lockfile-watcher.client";
import log from "./logger";
import { installPresenceMonitor } from "./presence";
import { getSessionToken } from "./session-token-store.client";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";

export const installHostProxyBridge = (
  resolveCliInvocation: () => Promise<CliInvocation>,
): (() => void) => {
  const browserExecutor = new HostBrowserExecutor();
  const uiSnapshotExecutor = createHostUiSnapshotExecutor({
    resolveRendererBase: () =>
      app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
  });
  const runtime: HostProxyRuntime = {
    acquireGuardianToken: async (assistantId) => {
      const configDir = resolveConfigDir(process.env);
      let invocation: CliInvocation;
      try {
        invocation = await resolveCliInvocation();
      } catch (err) {
        log.error("[host-proxy-router] failed to resolve CLI invocation", {
          assistantId,
          err,
        });
        return null;
      }

      const result = await getGuardianAccessToken(
        assistantId,
        configDir,
        invocation,
        true,
        { VELLUM_ENVIRONMENT: resolveEnvironmentName(process.env) },
      );
      if (!result.ok) {
        log.warn("[host-proxy-router] failed to obtain guardian token", {
          assistantId,
          error: result.error,
        });
        return null;
      }
      return result.accessToken;
    },
    getSessionToken,
    getLockfile: getWatchedLockfile,
    onLockfileChange,
    installPresenceMonitor,
    ...createHostProxyClientHeaders({
      getClientId: getDeviceId,
      getMachineName: hostname,
      interfaceId: "macos",
    }),
    executors: {
      host_bash: hostBashExecutor,
      host_file: hostFileExecutor,
      host_transfer: hostTransferExecutor,
      host_browser: browserExecutor,
      host_cu: hostCuExecutor,
      host_app_control: hostAppControlExecutor,
      host_ui_snapshot: uiSnapshotExecutor,
    },
    teardownExecutors: () => {
      browserExecutor.destroy();
      shutdownSharedCuHelper();
    },
    logger: log,
  };
  return installSharedHostProxyBridge(runtime);
};

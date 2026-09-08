/**
 * Computer-use action executor backed by the Linux native helper. `host_cu`
 * proxies `cu.perform`. Until a Linux sidecar exists, the placeholder helper
 * fails closed and capability modules report unavailable.
 */

import { BrowserWindow } from "electron";

import {
  capabilityToken,
  type CapabilityModule,
  type DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { createCuHelperProxyExecutor } from "@vellumai/electron-desktop/host-proxy/cu-executor";
import type { CuHelperClient } from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";

import { getLinuxHelperClient } from "../linux-helper";
import log from "../logger";

export interface ComputerUseActionExecutors {
  host_cu: HostProxyExecutor;
  teardown: () => void;
}

export const COMPUTER_USE_ACTION_EXECUTORS =
  capabilityToken<ComputerUseActionExecutors>(
    "desktop.computer-use-action-executors",
  );

export const getSharedCuHelper = () => getLinuxHelperClient();

type ContentProtectionWindow = Pick<
  BrowserWindow,
  "isContentProtected" | "setContentProtection"
>;

export const protectComputerUseCapture = (
  helper: CuHelperClient,
  getWindows: () => ContentProtectionWindow[],
): CuHelperClient => {
  let activeCalls = 0;
  let protectedWindows: ContentProtectionWindow[] = [];
  return {
    call: async (method, params) => {
      activeCalls += 1;
      if (activeCalls === 1) {
        const windows = getWindows().filter(
          (window) => !window.isContentProtected(),
        );
        try {
          for (const window of windows) {
            window.setContentProtection(true);
            protectedWindows.push(window);
          }
        } catch (error) {
          for (const window of protectedWindows) {
            window.setContentProtection(false);
          }
          protectedWindows = [];
          activeCalls -= 1;
          throw error;
        }
      }
      try {
        return await helper.call(method, params);
      } finally {
        activeCalls -= 1;
        if (activeCalls === 0) {
          for (const window of protectedWindows) {
            window.setContentProtection(false);
          }
          protectedWindows = [];
        }
      }
    },
  };
};

let protectedSharedHelper: CuHelperClient | null = null;

const getProtectedSharedCuHelper = (): CuHelperClient => {
  protectedSharedHelper ??= protectComputerUseCapture(
    getSharedCuHelper(),
    () => BrowserWindow.getAllWindows(),
  );
  return protectedSharedHelper;
};

export const shutdownSharedCuHelper = (): void => {
  protectedSharedHelper = null;
};

export interface LinuxCuExecutorDeps {
  helper?: CuHelperClient;
}

export const createLinuxHostCuExecutor = (
  deps: LinuxCuExecutorDeps = {},
): HostProxyExecutor => {
  const { helper } = deps;
  return createCuHelperProxyExecutor({
    logger: log,
    resolveHelper: helper ? () => helper : getProtectedSharedCuHelper,
  });
};

const computerUseActionsFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "computer-use-actions",
  install: (capabilities) => {
    capabilities.provide(COMPUTER_USE_ACTION_EXECUTORS, {
      host_cu: createLinuxHostCuExecutor(),
      teardown: shutdownSharedCuHelper,
    });
  },
};

export default computerUseActionsFeature;

/**
 * Computer-use action executor backed by the Windows native helper. `host_cu`
 * proxies `cu.perform`; the helper owns the verify, execute, settle, observe
 * cycle natively, preserving the committed computer-use result shape. The
 * executor is provided through the capability registry for final composition.
 */

import { join } from "node:path";

import { app, BrowserWindow } from "electron";

import {
  capabilityToken,
  type CapabilityModule,
  type DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { createCuHelperProxyExecutor } from "@vellumai/electron-desktop/host-proxy/cu-executor";
import type { CuHelperClient } from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";
import { NativeSidecarClient } from "@vellumai/native-sidecar/supervisor";

import log from "../logger";

export interface ComputerUseActionExecutors {
  host_cu: HostProxyExecutor;
  teardown: () => void;
}

export const COMPUTER_USE_ACTION_EXECUTORS =
  capabilityToken<ComputerUseActionExecutors>(
    "desktop.computer-use-action-executors",
  );

// Just above the daemon's 60s host-proxy request timeout so the daemon stays
// authoritative and the client timeout only catches a genuinely hung helper.
export const CU_HELPER_TIMEOUT_MS = 65_000;

/** Published by scripts/build-native-helper.ts under resources/native-helper. */
export const getWindowsHelperPath = (): string => {
  const root = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return join(root, "native-helper", arch, "Vellum.WindowsHelper.exe");
};

let sharedHelper: NativeSidecarClient | null = null;

// Lazily spawned, so users who never invoke computer use pay nothing.
export const getSharedCuHelper = (): NativeSidecarClient => {
  sharedHelper ??= new NativeSidecarClient({
    name: "windows helper (computer use)",
    resolveExecutablePath: getWindowsHelperPath,
    logger: log,
    responseTimeoutMs: CU_HELPER_TIMEOUT_MS,
    spawnEnv: {
      VELLUM_HOST_PID: String(process.pid),
    },
  });
  return sharedHelper;
};

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
  sharedHelper?.shutdown();
  sharedHelper = null;
  protectedSharedHelper = null;
};

export interface WindowsCuExecutorDeps {
  helper?: CuHelperClient;
}

export const createWindowsHostCuExecutor = (
  deps: WindowsCuExecutorDeps = {},
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
      host_cu: createWindowsHostCuExecutor(),
      teardown: shutdownSharedCuHelper,
    });
  },
};

export default computerUseActionsFeature;

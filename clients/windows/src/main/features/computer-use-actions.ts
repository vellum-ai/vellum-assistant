/**
 * Computer-use action executor backed by the Windows native helper. `host_cu`
 * proxies `cu.perform`; the helper owns the verify, execute, settle, observe
 * cycle natively, preserving the committed computer-use result shape. The
 * executor is provided through the capability registry for final composition.
 */

import { join } from "node:path";

import { app } from "electron";
import { z } from "zod";

import {
  capabilityToken,
  type CapabilityModule,
  type DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  HostHelperProxyExecutor,
  type CuHelperClient,
  type HostHelperProxyConfig,
} from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
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
  });
  return sharedHelper;
};

export const shutdownSharedCuHelper = (): void => {
  sharedHelper?.shutdown();
  sharedHelper = null;
};

// The helper returns only the observation fields; `requestId` is added when
// posting. Unknown keys are tolerated so a newer helper can extend the shape.
const CU_RESULT_SCHEMA = z
  .object({
    axTree: z.string().optional(),
    axDiff: z.string().optional(),
    screenshot: z.string().optional(),
    screenshotWidthPx: z.number().optional(),
    screenshotHeightPx: z.number().optional(),
    screenWidthPt: z.number().optional(),
    screenHeightPt: z.number().optional(),
    executionResult: z.string().optional(),
    executionError: z.string().optional(),
    secondaryWindows: z.string().optional(),
  })
  .passthrough();

export interface WindowsCuExecutorDeps {
  helper?: CuHelperClient;
}

function cuConfig(
  deps: WindowsCuExecutorDeps,
): HostHelperProxyConfig<z.infer<typeof CU_RESULT_SCHEMA>> {
  return {
    label: "host-cu-executor",
    logger: log,
    method: "cu.perform",
    resolveHelper: deps.helper
      ? () => deps.helper as CuHelperClient
      : getSharedCuHelper,
    schema: CU_RESULT_SCHEMA,
    buildParams: (message, requestId) => {
      const toolName = message.toolName as string | undefined;
      if (!toolName) return { error: "Missing toolName" };
      return {
        params: {
          requestId,
          conversationId: (message.conversationId as string | undefined) ?? "",
          toolName,
          input: (message.input as Record<string, unknown> | undefined) ?? {},
          stepNumber: (message.stepNumber as number | undefined) ?? 1,
          ...(typeof message.reasoning === "string"
            ? { reasoning: message.reasoning }
            : {}),
        },
      };
    },
    postSuccess: (poster, requestId, result) => {
      void poster.postCuResult({ requestId, ...result });
    },
    postError: (poster, requestId, message) => {
      void poster.postCuResult({ requestId, executionError: message });
    },
  };
}

export const createWindowsHostCuExecutor = (
  deps: WindowsCuExecutorDeps = {},
): HostProxyExecutor => new HostHelperProxyExecutor(cuConfig(deps));

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

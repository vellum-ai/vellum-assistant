/**
 * Computer-use observation feature: owns the lazily-spawned Windows native
 * helper client for UI Automation observation and aligned display capture.
 * All bounds are physical pixels in the Windows virtual desktop space (see
 * clients/windows/native/README.md). Action executors build on these calls.
 */

import { app } from "electron";
import path from "node:path";
import { z } from "zod";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { NativeSidecarClient } from "@vellumai/native-sidecar/supervisor";

import log from "../logger";

// Just above the daemon's 60s host-proxy timeout so it stays authoritative.
export const CU_HELPER_TIMEOUT_MS = 65_000;

export const getWindowsHelperPath = (
  arch: string = process.arch,
  packaged: boolean = app.isPackaged,
): string => {
  const helperArch = arch === "arm64" ? "arm64" : "x64";
  const baseDir = packaged
    ? path.join(process.resourcesPath, "native-helper")
    : path.join(app.getAppPath(), "resources", "native-helper");
  return path.join(baseDir, helperArch, "Vellum.WindowsHelper.exe");
};

const UNAVAILABLE_SCHEMA = z.object({ code: z.string(), message: z.string() });

// Unknown keys are tolerated so a newer helper can extend the shapes.
export const OBSERVATION_RESULT_SCHEMA = z
  .object({
    kind: z.enum(["full", "diff"]),
    tree: z.string().optional(),
    diff: z.string().optional(),
    foregroundApp: z
      .object({
        name: z.string(),
        processId: z.number(),
        windowTitle: z.string().optional(),
      })
      .optional(),
    secondaryWindows: z.string(),
    unavailable: UNAVAILABLE_SCHEMA.optional(),
  })
  .passthrough();

export const CAPTURE_RESULT_SCHEMA = z
  .object({
    pngBase64: z.string().optional(),
    widthPx: z.number().optional(),
    heightPx: z.number().optional(),
    scalePercent: z.number().optional(),
    unavailable: UNAVAILABLE_SCHEMA.optional(),
  })
  .passthrough();

export type ObservationResult = z.infer<typeof OBSERVATION_RESULT_SCHEMA>;
export type CaptureResult = z.infer<typeof CAPTURE_RESULT_SCHEMA>;
type RpcClient = Pick<NativeSidecarClient, "call">;
let sharedClient: NativeSidecarClient | null = null;

export const getSharedObserveHelper = (): NativeSidecarClient => {
  sharedClient ??= new NativeSidecarClient({
    name: "windows helper (computer use)",
    resolveExecutablePath: () => getWindowsHelperPath(),
    logger: log,
    responseTimeoutMs: CU_HELPER_TIMEOUT_MS,
  });
  return sharedClient;
};

export const observeAutomation = async (
  params: { conversationId: string; mode?: "full" | "diff" },
  client: RpcClient = getSharedObserveHelper(),
): Promise<ObservationResult> =>
  OBSERVATION_RESULT_SCHEMA.parse(
    await client.call("automation.observe", params),
  );

export const captureDisplay = async (
  params: { displayId?: number } = {},
  client: RpcClient = getSharedObserveHelper(),
): Promise<CaptureResult> =>
  CAPTURE_RESULT_SCHEMA.parse(await client.call("capture.display", params));

export const shutdownObserveHelper = (): void => {
  sharedClient?.shutdown();
  sharedClient = null;
};

const computerUseObserve: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "computer-use-observe",
  install: () => {
    app.once("before-quit", shutdownObserveHelper);
  },
};

export default computerUseObserve;

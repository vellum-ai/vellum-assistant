/**
 * Computer-use host-proxy executor shared by the desktop clients. It forwards a
 * single `host_cu_request` action (click / type / key / scroll / drag / open-app
 * / run-applescript / observe / wait) to the native helper's `cu.perform`
 * JSON-RPC method and posts the resulting observation (AX tree, diff,
 * screenshot, and px/pt screen metadata) back to the daemon.
 *
 * The helper owns the verify, execute, settle, observe cycle natively; this
 * executor only translates the SSE request into the helper call. Each client
 * supplies its own helper resolver and logger.
 */

import { z } from "zod";

import {
  HostHelperProxyExecutor,
  type CuHelperClient,
  type HostHelperProxyConfig,
} from "./helper-proxy-executor";
import type { HostProxyExecutor, HostProxyLogger } from "./router";

// The helper returns only the observation fields; `requestId` is added when
// posting. Unknown keys are tolerated so a newer helper can extend the shape.
export const CU_RESULT_SCHEMA = z
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

export type CuResult = z.infer<typeof CU_RESULT_SCHEMA>;

export interface CuExecutorDeps {
  logger: HostProxyLogger;
  resolveHelper: () => CuHelperClient;
  /** Only enable on hosts whose native helper supports CGWindowID capture. */
  supportsWindowCapture?: boolean;
}

export function cuExecutorConfig(
  deps: CuExecutorDeps,
): HostHelperProxyConfig<CuResult> {
  return {
    label: "host-cu-executor",
    logger: deps.logger,
    method: "cu.perform",
    resolveHelper: deps.resolveHelper,
    schema: CU_RESULT_SCHEMA,
    buildParams: (message, requestId) => {
      const toolName = message.toolName as string | undefined;
      if (!toolName) {
        return { error: "Missing toolName" };
      }
      const input = { ...((message.input as Record<string, unknown> | undefined) ?? {}) };
      if (input.capture_window_id !== undefined) {
        if (!deps.supportsWindowCapture) {
          return { error: "Window-scoped observation is not supported by this desktop client." };
        }
        if (toolName !== "computer_use_observe") {
          return { error: "capture_window_id is only supported for computer_use_observe." };
        }
        const windowId = input.capture_window_id;
        if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId < 1 || windowId > 0xffffffff) {
          return { error: "capture_window_id must be a positive 32-bit native window ID." };
        }
        if (input.captureWindowId !== undefined || input.captureDisplayId !== undefined) {
          return { error: "Specify only one capture target." };
        }
        input.captureWindowId = windowId;
        delete input.capture_window_id;
      }
      return {
        params: {
          requestId,
          conversationId: (message.conversationId as string | undefined) ?? "",
          toolName,
          input,
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

export function createCuHelperProxyExecutor(
  deps: CuExecutorDeps,
): HostProxyExecutor {
  return new HostHelperProxyExecutor(cuExecutorConfig(deps));
}

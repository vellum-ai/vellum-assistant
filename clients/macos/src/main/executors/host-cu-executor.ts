/**
 * Host computer-use executor — proxies a single `host_cu_request` action
 * (click / type / key / scroll / drag / open-app / run-applescript / observe /
 * wait) to the native mac-helper's `cu.perform` JSON-RPC method, then posts the
 * resulting observation (AX tree, diff, screenshot, and px/pt screen metadata)
 * back to the daemon.
 *
 * The helper owns the verify → execute → settle → observe cycle natively; this
 * executor only translates the SSE request into the helper call.
 */

import { z } from "zod";

import type { HostProxyExecutor } from "../host-proxy-router";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";
import {
  HostHelperProxyExecutor,
  type CuHelperClient,
  type HostHelperProxyConfig,
} from "./host-helper-proxy-executor";

export interface HostCuExecutorDeps {
  helper?: CuHelperClient;
}

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

function config(deps: HostCuExecutorDeps): HostHelperProxyConfig<
  z.infer<typeof CU_RESULT_SCHEMA>
> {
  return {
    label: "host-cu-executor",
    method: "cu.perform",
    resolveHelper: deps.helper ? () => deps.helper as CuHelperClient : getSharedCuHelper,
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
          ...(typeof message.reasoning === "string" ? { reasoning: message.reasoning } : {}),
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

export function createHostCuExecutor(deps: HostCuExecutorDeps = {}): HostProxyExecutor {
  return new HostHelperProxyExecutor(config(deps));
}

export const hostCuExecutor: HostProxyExecutor = createHostCuExecutor();

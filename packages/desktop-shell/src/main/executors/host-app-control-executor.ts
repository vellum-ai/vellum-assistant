/**
 * Host app-control executor — proxies a single `host_app_control_request`
 * (start / observe / press / combo / sequence / type / click / drag / stop) to
 * the native mac-helper's `appControl.perform` JSON-RPC method, then posts the
 * result (window state, PNG screenshot, window bounds) back to the daemon.
 *
 * App-control input is a discriminated union keyed by a `tool` field that the
 * daemon injects into `input`; the helper decodes it natively. This executor
 * only forwards the request and translates the result.
 */

import { z } from "zod";

import type { HostProxyExecutor } from "../host-proxy-router";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";
import {
  HostHelperProxyExecutor,
  type CuHelperClient,
  type HostHelperProxyConfig,
} from "./host-helper-proxy-executor";

export interface HostAppControlExecutorDeps {
  helper?: CuHelperClient;
}

const APP_CONTROL_RESULT_SCHEMA = z
  .object({
    state: z.enum(["running", "missing", "minimized"]),
    pngBase64: z.string().optional(),
    windowBounds: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional(),
    executionResult: z.string().optional(),
    executionError: z.string().optional(),
  })
  .passthrough();

function config(deps: HostAppControlExecutorDeps): HostHelperProxyConfig<
  z.infer<typeof APP_CONTROL_RESULT_SCHEMA>
> {
  return {
    label: "host-app-control-executor",
    method: "appControl.perform",
    resolveHelper: deps.helper ? () => deps.helper as CuHelperClient : getSharedCuHelper,
    schema: APP_CONTROL_RESULT_SCHEMA,
    buildParams: (message, requestId) => {
      const input = message.input as Record<string, unknown> | undefined;
      if (!input) return { error: "Missing input" };
      return {
        params: {
          requestId,
          conversationId: (message.conversationId as string | undefined) ?? "",
          ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
          input,
        },
      };
    },
    postSuccess: (poster, requestId, result) => {
      void poster.postAppControlResult({ requestId, ...result });
    },
    postError: (poster, requestId, message) => {
      void poster.postAppControlResult({ requestId, state: "missing", executionError: message });
    },
  };
}

export function createHostAppControlExecutor(
  deps: HostAppControlExecutorDeps = {},
): HostProxyExecutor {
  return new HostHelperProxyExecutor(config(deps));
}

export const hostAppControlExecutor: HostProxyExecutor = createHostAppControlExecutor();

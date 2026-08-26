/**
 * App-control host-proxy executor shared by the desktop clients. It forwards a
 * single `host_app_control_request` (start / observe / press / combo /
 * sequence / type / click / drag / stop) to the native helper's
 * `appControl.perform` JSON-RPC method and posts the result (window state,
 * PNG screenshot, window bounds) back to the daemon.
 *
 * App-control input is a discriminated union keyed by a `tool` field that the
 * daemon injects into `input`; the helper decodes it natively. Each client
 * supplies its own helper resolver and logger.
 */

import { z } from "zod";

import {
  HostHelperProxyExecutor,
  type CuHelperClient,
  type HostHelperProxyConfig,
} from "./helper-proxy-executor";
import type { HostProxyExecutor, HostProxyLogger } from "./router";

export const APP_CONTROL_RESULT_SCHEMA = z
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

export type AppControlResult = z.infer<typeof APP_CONTROL_RESULT_SCHEMA>;

export interface AppControlExecutorDeps {
  logger: HostProxyLogger;
  resolveHelper: () => CuHelperClient;
}

export function appControlExecutorConfig(
  deps: AppControlExecutorDeps,
): HostHelperProxyConfig<AppControlResult> {
  return {
    label: "host-app-control-executor",
    logger: deps.logger,
    method: "appControl.perform",
    resolveHelper: deps.resolveHelper,
    schema: APP_CONTROL_RESULT_SCHEMA,
    buildParams: (message, requestId) => {
      const input = message.input as Record<string, unknown> | undefined;
      if (!input) return { error: "Missing input" };
      return {
        params: {
          requestId,
          conversationId: (message.conversationId as string | undefined) ?? "",
          ...(typeof message.toolName === "string"
            ? { toolName: message.toolName }
            : {}),
          input,
        },
      };
    },
    postSuccess: (poster, requestId, result) => {
      void poster.postAppControlResult({ requestId, ...result });
    },
    postError: (poster, requestId, message) => {
      void poster.postAppControlResult({
        requestId,
        state: "missing",
        executionError: message,
      });
    },
  };
}

export function createAppControlHelperProxyExecutor(
  deps: AppControlExecutorDeps,
): HostProxyExecutor {
  return new HostHelperProxyExecutor(appControlExecutorConfig(deps));
}

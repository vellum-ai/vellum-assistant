import {
  missingAppIdError,
  resolveAppId,
} from "../../../../tools/apps/resolve-app-id.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

/**
 * Proxy executor: forwards the open request to the connected client via the
 * request-bound proxy resolver (same dispatch path as ui_show). The daemon
 * side registers the dynamic_page surface and auto-compiles stale apps in
 * `surfaceProxyResolver` — this executor only routes.
 */
export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const appId = resolveAppId(input, context.conversationId);
  if (!appId) {
    return missingAppIdError();
  }
  if (!context.proxyToolResolver) {
    return {
      content:
        "app_open requires a connected client UI (macOS or web app), and none is connected to this conversation. The app is saved — the user can open it from a connected client.",
      isError: true,
    };
  }
  return context.proxyToolResolver("app_open", { ...input, app_id: appId });
}

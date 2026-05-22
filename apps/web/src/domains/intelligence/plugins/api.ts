/**
 * Hand-written fetch wrappers for assistant plugins endpoints.
 *
 * The endpoints described here are not yet implemented in the daemon —
 * they're added in lockstep with the Plugins tab UI so we can iterate
 * on the frontend ahead of the runtime work. Until the daemon ships
 * `/v1/assistants/{id}/plugins/*`, `fetchPlugins` treats HTTP 404 as an
 * empty result and the UI renders an empty state.
 *
 * Endpoint contract (matches the CLI surface in
 * `assistant/src/cli/commands/plugins.ts`):
 *   - GET    /v1/assistants/{id}/plugins/                — list (installed + catalog)
 *   - POST   /v1/assistants/{id}/plugins/install         — install by name
 *   - DELETE /v1/assistants/{id}/plugins/{name}          — uninstall by name
 *
 * Daemon implementation tracked separately and intentionally NOT in this PR.
 */

import {
  ApiError,
  assertHasResponse,
  client,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/domains/intelligence/client.js";

import type {
  InstallPluginRequest,
  InstallPluginResponse,
  PluginsListResponse,
} from "./types.js";

export { ApiError };

export interface FetchPluginsParams {
  readonly kind?: "installed" | "available";
  readonly query?: string;
}

function buildQuery(params: FetchPluginsParams): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.kind) query.kind = params.kind;
  if (params.query) query.q = params.query;
  return query;
}

/**
 * List plugins for an assistant.
 *
 * Treats HTTP 404 (endpoint not implemented yet) as an empty result so
 * the UI degrades to an empty state instead of throwing. Real network /
 * 5xx errors still surface via `ApiError` so they can be displayed in
 * the tab.
 */
export async function fetchPlugins(
  assistantId: string,
  params: FetchPluginsParams = {},
): Promise<PluginsListResponse> {
  const { data, error, response } = await client.get<PluginsListResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/plugins/",
    path: { assistant_id: assistantId },
    query: buildQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load plugins.");
  if (response.status === 404) {
    return { plugins: [] };
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load plugins."),
    );
  }
  return data ?? { plugins: [] };
}

export async function installPlugin(
  assistantId: string,
  body: InstallPluginRequest,
): Promise<InstallPluginResponse> {
  const { data, error, response } = await client.post<InstallPluginResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/plugins/install",
    path: { assistant_id: assistantId },
    body,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to install plugin.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to install plugin."),
    );
  }
  return data ?? { ok: true };
}

export async function uninstallPlugin(
  assistantId: string,
  pluginName: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/plugins/{plugin_name}",
    path: { assistant_id: assistantId, plugin_name: pluginName },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to uninstall plugin.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to uninstall plugin."),
    );
  }
}

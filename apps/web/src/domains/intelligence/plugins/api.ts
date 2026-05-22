/**
 * Hand-written fetch wrappers for assistant plugins endpoints.
 *
 * The endpoint described here is not yet implemented in the daemon —
 * it's added in lockstep with the Plugins tab UI so the frontend can
 * iterate ahead of the runtime work. Until the daemon ships
 * `/v1/assistants/{id}/plugins/`, `fetchPlugins` treats HTTP 404 as
 * an empty result and the UI renders an empty state.
 *
 * Endpoint contract (matches the CLI surface in
 * `assistant/src/cli/commands/plugins.ts`):
 *   - GET    /v1/assistants/{id}/plugins/    — list installed plugins
 *
 * Install / uninstall are intentionally not exposed via the web tab
 * yet — the CLI remains the install surface while the shape of an
 * installed plugin firms up.
 */

import {
  ApiError,
  assertHasResponse,
  client,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/domains/intelligence/client.js";

import type { PluginsListResponse } from "./types.js";

export { ApiError };

export interface FetchPluginsParams {
  readonly query?: string;
}

function buildQuery(params: FetchPluginsParams): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.query) query.q = params.query;
  return query;
}

/**
 * List installed plugins for an assistant.
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

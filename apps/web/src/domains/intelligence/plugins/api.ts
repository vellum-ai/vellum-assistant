/**
 * Hand-written fetch wrappers for assistant plugins endpoints.
 *
 * Endpoint contract (matches the CLI surface in
 * `assistant/src/cli/commands/plugins.ts`):
 *   - GET    /v1/assistants/{id}/plugins/         — list installed plugins
 *   - GET    /v1/assistants/{id}/plugins/search/  — search the GitHub catalog
 *
 * `fetchPlugins` still treats HTTP 404 as an empty result so the tab
 * degrades gracefully on older daemons that predate the list endpoint.
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
} from "@/domains/intelligence/client";

import type {
  PluginCatalogResponse,
  PluginsListResponse,
} from "./types";

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

export interface FetchPluginCatalogParams {
  /**
   * ECMAScript regex source matched (case-insensitive, partial) against
   * each catalog directory name. Empty / undefined means match-all,
   * mirroring the daemon contract.
   */
  readonly query?: string;
  /**
   * Catalog git ref to list against. Omitted → daemon default
   * (typically `main`). Whitespace-only values are normalized server-side.
   */
  readonly ref?: string;
}

/**
 * Escape regex meta-characters so the daemon's `plugins_search`
 * endpoint (which takes `q` as an ECMAScript regex) behaves like a
 * case-insensitive substring match. The plain-text contract matches
 * what the user types into the search input.
 */
function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCatalogQuery(
  params: FetchPluginCatalogParams,
): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.query) query.q = escapeForRegex(params.query);
  if (params.ref) query.ref = params.ref;
  return query;
}

/**
 * Search the plugin catalog for directories matching `query`.
 *
 * Empty / undefined `query` returns every catalog entry (match-all),
 * matching the daemon contract. 4xx errors surface as `ApiError`; 404
 * is preserved as a real error here because, unlike list, search has
 * no "endpoint missing" fallback — older daemons just don't have it.
 */
export async function fetchPluginCatalog(
  assistantId: string,
  params: FetchPluginCatalogParams = {},
): Promise<PluginCatalogResponse> {
  const { data, error, response } = await client.get<
    PluginCatalogResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/plugins/search/",
    path: { assistant_id: assistantId },
    query: buildCatalogQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load plugin catalog.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load plugin catalog."),
    );
  }
  return (
    data ?? { query: params.query ?? "", ref: params.ref ?? "", matches: [] }
  );
}

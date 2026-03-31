/**
 * Route handlers for listing and getting OAuth providers.
 *
 * Provides read-only endpoints for querying the registered OAuth provider
 * catalog. All endpoints are bearer-token authenticated via the standard
 * runtime auth middleware.
 */

import { loadConfig } from "../../config/loader.js";
import { getProvider, listProviders } from "../../oauth/oauth-store.js";
import { serializeProviderSummary } from "../../oauth/provider-serializer.js";
import { isProviderVisible } from "../../oauth/provider-visibility.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

/**
 * Build route definitions for OAuth provider list/get endpoints.
 */
export function oauthProvidersRouteDefinitions(): RouteDefinition[] {
  return [
    // GET /v1/oauth/providers — List all providers with optional filtering.
    {
      endpoint: "oauth/providers",
      method: "GET",
      handler: ({ url }) => {
        const rows = listProviders();
        const config = loadConfig();
        const visibleRows = rows.filter((r) => isProviderVisible(r, config));
        let serialized = visibleRows
          .map((row) => serializeProviderSummary(row))
          .filter((s): s is NonNullable<typeof s> => s !== null);

        const supportsManagedModeParam = url.searchParams.get(
          "supports_managed_mode",
        );
        if (supportsManagedModeParam === "true") {
          serialized = serialized.filter((p) => p.supports_managed_mode);
        } else if (supportsManagedModeParam === "false") {
          serialized = serialized.filter((p) => !p.supports_managed_mode);
        }

        return Response.json({ providers: serialized });
      },
    },

    // GET /v1/oauth/providers/:providerKey — Get a single provider.
    {
      endpoint: "oauth/providers/:providerKey",
      method: "GET",
      handler: ({ params }) => {
        const row = getProvider(params.providerKey);
        if (!row) {
          return httpError(
            "NOT_FOUND",
            `No OAuth provider registered for "${params.providerKey}"`,
            404,
          );
        }

        if (!isProviderVisible(row, loadConfig())) {
          return httpError(
            "NOT_FOUND",
            `No OAuth provider registered for "${params.providerKey}"`,
            404,
          );
        }

        return Response.json({ provider: serializeProviderSummary(row) });
      },
    },
  ];
}

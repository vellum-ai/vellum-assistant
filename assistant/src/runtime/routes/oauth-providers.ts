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
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function handleListProviders({ queryParams = {} }: RouteHandlerArgs) {
  const rows = listProviders();
  const config = loadConfig();
  const visibleRows = rows.filter((r) => isProviderVisible(r, config));
  let serialized = visibleRows
    .map((row) => serializeProviderSummary(row))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const supportsManagedMode = queryParams.supports_managed_mode;
  if (supportsManagedMode === "true") {
    serialized = serialized.filter((p) => p.supports_managed_mode);
  } else if (supportsManagedMode === "false") {
    serialized = serialized.filter((p) => !p.supports_managed_mode);
  }

  return { providers: serialized };
}

function handleGetProvider({ pathParams = {} }: RouteHandlerArgs) {
  const { providerKey } = pathParams;
  const row = getProvider(providerKey);
  if (!row) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  if (!isProviderVisible(row, loadConfig())) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  return { provider: serializeProviderSummary(row) };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_providers_get",
    endpoint: "oauth/providers",
    method: "GET",
    summary: "List OAuth providers",
    description:
      "List all registered OAuth providers with optional filtering.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    handler: handleListProviders,
    queryParams: [
      {
        name: "supports_managed_mode",
        schema: { type: "string" },
        description: "Filter by managed mode support (true/false)",
      },
    ],
  },
  {
    operationId: "oauth_providers_by_providerKey_get",
    endpoint: "oauth/providers/:providerKey",
    method: "GET",
    summary: "Get OAuth provider",
    description: "Get a single OAuth provider by key.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    handler: handleGetProvider,
  },
];

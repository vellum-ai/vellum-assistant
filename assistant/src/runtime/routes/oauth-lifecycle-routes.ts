/**
 * Transport-agnostic routes for OAuth lifecycle events.
 *
 * Allows CLI commands to notify the daemon when OAuth state changes
 * (e.g. after `assistant oauth connect`) so the daemon can refresh its
 * cached config and credential state.
 */

import { z } from "zod";

import { getConfig, invalidateConfigCache } from "../../config/loader.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Handlers ──────────────────────────────────────────────────────────

function handleOAuthConnectionChanged(_args: RouteHandlerArgs): {
  refreshed: boolean;
} {
  invalidateConfigCache();
  // Force re-read from disk so subsequent resolveOAuthConnection() calls
  // in this process see the current mode setting.
  getConfig();
  return { refreshed: true };
}

// ── Routes ────────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_connection_changed",
    endpoint: "oauth/connection-changed",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleOAuthConnectionChanged,
    summary: "Notify the assistant that an OAuth connection changed",
    description:
      "Invalidates the config cache so the assistant picks up mode and credential changes immediately.",
    tags: ["oauth"],
    responseBody: z.object({
      refreshed: z.boolean(),
    }),
  },
];

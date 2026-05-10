/**
 * Route handlers for platform authentication status.
 *
 * Exposes auth/status as a GET endpoint, returning the platform identity
 * fields and whether the assistant is authenticated with the Vellum platform.
 *
 * Auth is enforced at the transport layer — handlers contain only business logic.
 */

import {
  getPlatformAssistantId,
  getPlatformBaseUrl,
  getPlatformOrganizationId,
  getPlatformUserId,
} from "../../config/env.js";
import { resolveManagedProxyContext } from "../../providers/managed-proxy/context.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

async function handleAuthStatus(_args: RouteHandlerArgs) {
  const ctx = await resolveManagedProxyContext();

  const platformUrl = getPlatformBaseUrl();
  const assistantId = getPlatformAssistantId();
  const organizationId = getPlatformOrganizationId();
  const userId = getPlatformUserId();
  const authenticated = ctx.enabled;

  const result: {
    platformUrl: string | null;
    assistantId: string | null;
    organizationId: string | null;
    userId: string | null;
    authenticated: boolean;
    message?: string;
  } = {
    platformUrl: platformUrl || null,
    assistantId: assistantId || null,
    organizationId: organizationId || null,
    userId: userId || null,
    authenticated,
  };

  if (!authenticated) {
    result.message = !platformUrl
      ? "Platform URL not configured. Run assistant config set platform.baseUrl <url>"
      : "Assistant API key not found. Store one with: assistant keys set credential/vellum/assistant_api_key <key>";
  }

  return result;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "auth_status",
    endpoint: "auth/status",
    method: "GET",
    summary: "Get platform authentication status and identity",
    tags: ["auth"],
    handler: handleAuthStatus,
  },
];

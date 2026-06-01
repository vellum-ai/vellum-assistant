/**
 * Route handlers for authentication status.
 *
 * GET /v1/auth/info — return platform identity and authentication status
 */

import { z } from "zod";

import {
  getPlatformAssistantId,
  getPlatformBaseUrl,
  getPlatformOrganizationId,
  getPlatformUserId,
} from "../../config/env.js";
import { resolveManagedProxyContext } from "../../providers/platform-proxy/context.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

interface AuthInfoResult {
  platformUrl: string | null;
  assistantId: string | null;
  organizationId: string | null;
  userId: string | null;
  authenticated: boolean;
  message?: string;
}

async function handleAuthInfo(_args: RouteHandlerArgs): Promise<AuthInfoResult> {
  const ctx = await resolveManagedProxyContext();

  const platformUrl = getPlatformBaseUrl();
  const assistantId = getPlatformAssistantId();
  const organizationId = getPlatformOrganizationId();
  const userId = getPlatformUserId();
  const authenticated = ctx.enabled;

  const result: AuthInfoResult = {
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
    operationId: "auth_info",
    endpoint: "auth/info",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get authentication status",
    description:
      "Returns platform identity and authentication status for this assistant.",
    tags: ["auth"],
    responseBody: z.object({
      platformUrl: z.string().nullable(),
      assistantId: z.string().nullable(),
      organizationId: z.string().nullable(),
      userId: z.string().nullable(),
      authenticated: z.boolean(),
      message: z.string().optional(),
    }),
    handler: handleAuthInfo,
  },
];

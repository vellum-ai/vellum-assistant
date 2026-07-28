/**
 * Webhook route handlers for the shared HTTP/IPC route table.
 *
 * Serves two operations:
 *   - webhooks_register (POST webhooks/register): Resolve a stable callback URL
 *     for a webhook type. See `handleWebhooksRegister` for the resolution
 *     order.
 *   - webhooks_list (GET webhooks): List all webhook callback routes registered
 *     with the platform for this assistant.
 */

import { z } from "zod";

import { getIsPlatform } from "../../config/env-registry.js";
import { getConfig } from "../../config/loader.js";
import {
  registerCallbackRoute,
  resolvePlatformCallbackRegistrationContext,
} from "../../inbound/platform-callback-registration.js";
import {
  getPublicBaseUrl,
  isPublicIngressDisabled,
} from "../../inbound/public-ingress-urls.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  InternalError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const WebhooksRegisterRequestSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  source: z.string().optional(),
});

const WebhooksRegisterResponseSchema = z.object({
  callbackUrl: z.string(),
  type: z.string(),
  path: z.string(),
  mode: z.enum(["platform", "self-hosted"]),
});
type WebhooksRegisterResponse = z.infer<typeof WebhooksRegisterResponseSchema>;

const WebhookCallbackRouteSchema = z.object({
  id: z.string(),
  assistant_id: z.string(),
  type: z.string(),
  callback_path: z.string(),
  callback_url: z.string(),
  source_identifier: z.string().nullable(),
});

const WebhooksListResponseSchema = z.object({
  routes: z.array(WebhookCallbackRouteSchema),
});
type WebhooksListResponse = z.infer<typeof WebhooksListResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the webhook path from the type name.
 *
 * Convention: underscores become path separators, prefixed with `webhooks/`.
 *   telegram       → webhooks/telegram
 *   twilio_voice   → webhooks/twilio/voice
 *   twilio_status  → webhooks/twilio/status
 *   resend         → webhooks/resend
 *   oauth_callback → webhooks/oauth/callback
 */
function deriveWebhookPath(type: string): string {
  return `webhooks/${type.replace(/_/g, "/")}`;
}

/**
 * Register `webhookPath` with the platform gateway, mapping failures onto the
 * route error vocabulary.
 */
async function registerWithPlatform(
  webhookPath: string,
  type: string,
  source: string | undefined,
): Promise<WebhooksRegisterResponse> {
  let callbackUrl: string;
  try {
    callbackUrl = await registerCallbackRoute(webhookPath, type, source);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("missing platform registration context")) {
      throw new UnprocessableEntityError(msg);
    }
    throw new InternalError(`Failed to register callback route: ${msg}`);
  }
  return { callbackUrl, type, path: webhookPath, mode: "platform" };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Resolve a stable callback URL for a webhook type.
 *
 * Resolution order:
 *   1. **Platform pods** (`IS_PLATFORM`) always register with the platform
 *      gateway: they have no ingress of their own to advertise.
 *   2. **A configured public ingress wins** for everyone else. That URL is
 *      either the user's own tunnel (ngrok, a custom domain) or the Velay
 *      tunnel URL the gateway publishes into `ingress.publicBaseUrl`, so a
 *      platform-connected local assistant with a live tunnel already resolves
 *      to a stable platform-owned URL here.
 *   3. **Platform-connected assistants with no ingress** register with the
 *      platform gateway rather than failing. Connectivity is decided by
 *      credentials (platform base URL + assistant ID + assistant API key), not
 *      by `IS_PLATFORM`, which is only ever true on a platform pod.
 *
 * Ingress deliberately precedes platform registration: any logged-in local
 * assistant holds platform credentials (it needs them for the LLM proxy), so
 * treating credential presence as "managed" would silently reroute an
 * explicitly configured self-hosted webhook through the platform. The gateway's
 * Telegram and email registrars order the same two tiers the same way.
 */
async function handleWebhooksRegister(
  args: RouteHandlerArgs,
): Promise<WebhooksRegisterResponse> {
  const { type, path: pathOverride, source } = args.body ?? {};

  if (!type || typeof type !== "string") {
    throw new BadRequestError("type is required");
  }

  const webhookPath =
    (pathOverride as string | undefined) ?? deriveWebhookPath(type as string);
  const sourceIdentifier = source as string | undefined;

  if (getIsPlatform()) {
    return registerWithPlatform(webhookPath, type, sourceIdentifier);
  }

  const config = getConfig();
  if (isPublicIngressDisabled(config)) {
    throw new UnprocessableEntityError(
      "Public ingress is disabled. Ask the assistant to enable it, or update it from the Settings page.",
    );
  }

  let ingressError: Error;
  try {
    const baseUrl = getPublicBaseUrl(config);
    return {
      callbackUrl: `${baseUrl}/${webhookPath}`,
      type,
      path: webhookPath,
      mode: "self-hosted",
    };
  } catch (err) {
    ingressError = err as Error;
  }

  // No ingress configured. Fall back to the platform gateway when this
  // assistant is connected to the platform.
  const context = await resolvePlatformCallbackRegistrationContext();
  if (context.enabled) {
    return registerWithPlatform(webhookPath, type, sourceIdentifier);
  }

  throw new UnprocessableEntityError(ingressError.message);
}

async function handleWebhooksList(
  _args: RouteHandlerArgs,
): Promise<WebhooksListResponse> {
  const context = await resolvePlatformCallbackRegistrationContext();

  if (!context.platformBaseUrl || !context.authHeader) {
    throw new UnprocessableEntityError(
      "Self-hosted webhook listing is not available. Use 'assistant webhooks register <type>' to resolve URLs on demand.",
    );
  }

  const url = `${context.platformBaseUrl}/v1/internal/gateway/callback-routes/`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: context.authHeader,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new InternalError(
      `Failed to list webhook routes: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new InternalError(
      `Failed to list webhook routes (HTTP ${response.status}): ${detail}`,
    );
  }

  const routes = (await response.json()) as Array<{
    id: string;
    assistant_id: string;
    type: string;
    callback_path: string;
    callback_url: string;
    source_identifier: string | null;
  }>;

  return { routes };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "webhooks_register",
    endpoint: "webhooks/register",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Register a webhook callback URL",
    description:
      "Resolves a stable callback URL for a webhook type. On platform-managed assistants, registers the route with the platform gateway. Otherwise uses the configured ingress.publicBaseUrl, falling back to the platform gateway when no ingress is configured and the assistant is connected to the platform.",
    tags: ["webhooks"],
    requestBody: WebhooksRegisterRequestSchema,
    responseBody: WebhooksRegisterResponseSchema,
    handler: handleWebhooksRegister,
  },
  {
    operationId: "webhooks_list",
    endpoint: "webhooks",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List registered webhook callback routes",
    description:
      "Lists all webhook callback routes registered with the platform for this assistant.",
    tags: ["webhooks"],
    responseBody: WebhooksListResponseSchema,
    handler: handleWebhooksList,
  },
];

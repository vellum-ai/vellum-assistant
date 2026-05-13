/**
 * Webhook route handlers for the shared HTTP/IPC route table.
 *
 * Serves two operations:
 *   - webhooks_register (POST webhooks/register): Resolve a stable callback URL
 *     for a webhook type, registering with the platform gateway on
 *     platform-managed assistants or using the configured ingress.publicBaseUrl
 *     on self-hosted assistants.
 *   - webhooks_list (GET webhooks): List all webhook callback routes registered
 *     with the platform for this assistant.
 */

import { getIsPlatform } from "../../config/env-registry.js";
import { getConfig } from "../../config/loader.js";
import {
  registerCallbackRoute,
  resolvePlatformCallbackRegistrationContext,
} from "../../inbound/platform-callback-registration.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import {
  BadRequestError,
  InternalError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleWebhooksRegister(
  args: RouteHandlerArgs,
): Promise<unknown> {
  const { type, path: pathOverride, source } = args.body ?? {};

  if (!type || typeof type !== "string") {
    throw new BadRequestError("type is required");
  }

  const webhookPath =
    (pathOverride as string | undefined) ?? deriveWebhookPath(type as string);

  if (getIsPlatform()) {
    let callbackUrl: string;
    try {
      callbackUrl = await registerCallbackRoute(
        webhookPath,
        type as string,
        source as string | undefined,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("missing platform registration context")) {
        throw new UnprocessableEntityError(msg);
      }
      throw new InternalError(`Failed to register callback route: ${msg}`);
    }
    return { callbackUrl, type, path: webhookPath, mode: "platform" };
  }

  // Self-hosted: use ingress.publicBaseUrl
  const config = getConfig();
  let baseUrl: string;
  try {
    baseUrl = getPublicBaseUrl(config);
  } catch (err) {
    throw new UnprocessableEntityError((err as Error).message);
  }
  return {
    callbackUrl: `${baseUrl}/${webhookPath}`,
    type,
    path: webhookPath,
    mode: "self-hosted",
  };
}

async function handleWebhooksList(_args: RouteHandlerArgs): Promise<unknown> {
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
    summary: "Register a webhook callback URL",
    description:
      "Resolves a stable callback URL for a webhook type. On platform-managed assistants, registers the route with the platform gateway. On self-hosted assistants, uses the configured ingress.publicBaseUrl.",
    tags: ["webhooks"],
    handler: handleWebhooksRegister,
  },
  {
    operationId: "webhooks_list",
    endpoint: "webhooks",
    method: "GET",
    summary: "List registered webhook callback routes",
    description:
      "Lists all webhook callback routes registered with the platform for this assistant.",
    tags: ["webhooks"],
    handler: handleWebhooksList,
  },
];

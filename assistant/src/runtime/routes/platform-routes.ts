/**
 * Platform route handlers for the shared HTTP/IPC route table.
 *
 * Serves eight operations:
 *   - platform_status (GET platform/status): aggregates platform context,
 *     credentials, assistant ID, and webhook secret. (Velay tunnel status
 *     lives on the gateway — see gateway_status.)
 *   - platform_connect (POST platform/connect): checks existing credentials
 *     and emits the show_platform_login signal to connected clients.
 *   - platform_disconnect (POST platform/disconnect): deletes stored platform
 *     credentials and emits platform_disconnected signal.
 *   - platform_callback_routes_register (POST platform/callback-routes/register):
 *     registers a callback route with the platform gateway.
 *   - platform_callback_routes_list (GET platform/callback-routes): lists
 *     registered callback routes for this assistant.
 *   - platform_credits (GET platform/credits): fetches the org's remaining
 *     credit balance from the platform billing summary.
 *   - platform_subscription (GET platform/subscription): fetches the org's
 *     current plan, subscription status, and entitlements.
 *   - platform_plans (GET platform/plans): fetches the plan catalog with pricing.
 */

import { z } from "zod";

import { isPlatformRemote } from "../../config/env-registry.js";
import {
  registerCallbackRoute,
  resolvePlatformCallbackRegistrationContext,
} from "../../inbound/platform-callback-registration.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getExistingDeviceId } from "../../util/device-id.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  InternalError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Credential store keys
// ---------------------------------------------------------------------------

const CREDENTIAL_KEYS = {
  baseUrl: { service: "vellum", field: "platform_base_url" },
  apiKey: { service: "vellum", field: "assistant_api_key" },
  assistantId: { service: "vellum", field: "platform_assistant_id" },
  organizationId: { service: "vellum", field: "platform_organization_id" },
  userId: { service: "vellum", field: "platform_user_id" },
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PlatformStatusResponseSchema = z.object({
  isPlatform: z.boolean(),
  baseUrl: z.string(),
  assistantId: z.string(),
  hasAssistantApiKey: z.boolean(),
  hasWebhookSecret: z.boolean(),
  clientInstallationId: z.string().nullable(),
  available: z.boolean(),
  organizationId: z.string().nullable(),
  userId: z.string().nullable(),
});
type PlatformStatusResponse = z.infer<typeof PlatformStatusResponseSchema>;

const PlatformConnectResponseSchema = z.object({
  alreadyConnected: z.boolean().optional(),
  baseUrl: z.string().optional(),
  showPlatformLogin: z.boolean().optional(),
});
type PlatformConnectResponse = z.infer<typeof PlatformConnectResponseSchema>;

const PlatformDisconnectResponseSchema = z.object({
  disconnected: z.literal(true),
  previousBaseUrl: z.string().nullable(),
});
type PlatformDisconnectResponse = z.infer<
  typeof PlatformDisconnectResponseSchema
>;

const CallbackRouteRegisterRequestSchema = z.object({
  path: z.string(),
  type: z.string(),
});

const CallbackRouteRegisterResponseSchema = z.object({
  callbackUrl: z.string(),
  callbackPath: z.string(),
  type: z.string(),
});
type CallbackRouteRegisterResponse = z.infer<
  typeof CallbackRouteRegisterResponseSchema
>;

const CallbackRouteSchema = z.object({
  id: z.string(),
  assistant_id: z.string(),
  type: z.string(),
  callback_path: z.string(),
  callback_url: z.string(),
  source_identifier: z.string().nullable(),
});

const CallbackRoutesListResponseSchema = z.object({
  routes: z.array(CallbackRouteSchema),
});
type CallbackRoutesListResponse = z.infer<
  typeof CallbackRoutesListResponseSchema
>;

const PlatformCreditsResponseSchema = z.object({
  remaining: z.number(),
  settled: z.number(),
  pending: z.number(),
  unit: z.literal("USD"),
  stale: z.boolean(),
  as_of: z.string(),
});
type PlatformCreditsResponse = z.infer<typeof PlatformCreditsResponseSchema>;

const SubscriptionPackageSchema = z.object({
  key: z.string(),
  name: z.string(),
  version: z.number(),
  customized: z.boolean(),
});

const PlatformSubscriptionResponseSchema = z.object({
  planId: z.enum(["base", "pro"]),
  status: z.string().nullable(),
  renewalDate: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  cancelAt: z.string().nullable(),
  selectedCreditTier: z.string().nullable(),
  package: SubscriptionPackageSchema.nullable(),
  entitlements: z.object({
    managedEmail: z.boolean(),
    phoneNumber: z.boolean(),
  }),
});
type PlatformSubscriptionResponse = z.infer<
  typeof PlatformSubscriptionResponseSchema
>;

// The plan catalog is a large, platform-owned structure (base + pro plans, each
// with machine/storage/credit tiers and packages). The daemon forwards it as a
// pass-through so the catalog shape stays owned by the platform and additive
// changes there don't require a daemon schema bump; only the top-level `plans`
// envelope is asserted here.
const PlatformPlansResponseSchema = z.object({
  plans: z.array(z.record(z.string(), z.unknown())),
});
type PlatformPlansResponse = z.infer<typeof PlatformPlansResponseSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePlatformStatus(
  _args: RouteHandlerArgs,
): Promise<PlatformStatusResponse> {
  const context = await resolvePlatformCallbackRegistrationContext();

  const [orgIdRaw, userIdRaw, webhookSecretRaw] = await Promise.all([
    getSecureKeyAsync(
      credentialKey(
        CREDENTIAL_KEYS.organizationId.service,
        CREDENTIAL_KEYS.organizationId.field,
      ),
    ),
    getSecureKeyAsync(
      credentialKey(
        CREDENTIAL_KEYS.userId.service,
        CREDENTIAL_KEYS.userId.field,
      ),
    ),
    getSecureKeyAsync(credentialKey("vellum", "webhook_secret")),
  ]);

  const organizationId = orgIdRaw?.trim() ?? "";
  const userId = userIdRaw?.trim() ?? "";
  const hasWebhookSecret = !!webhookSecretRaw;

  return {
    isPlatform: context.isPlatform,
    baseUrl: context.platformBaseUrl,
    assistantId: context.assistantId,
    hasAssistantApiKey: context.hasAssistantApiKey,
    hasWebhookSecret,
    clientInstallationId: getExistingDeviceId(),
    available: context.enabled,
    organizationId: organizationId || null,
    userId: userId || null,
  };
}

async function handlePlatformConnect(
  _args: RouteHandlerArgs,
): Promise<PlatformConnectResponse> {
  // Check if already connected
  const [existingUrl, existingApiKey] = await Promise.all([
    getSecureKeyAsync(
      credentialKey(
        CREDENTIAL_KEYS.baseUrl.service,
        CREDENTIAL_KEYS.baseUrl.field,
      ),
    ),
    getSecureKeyAsync(
      credentialKey(
        CREDENTIAL_KEYS.apiKey.service,
        CREDENTIAL_KEYS.apiKey.field,
      ),
    ),
  ]);

  if (existingUrl && existingApiKey) {
    return {
      alreadyConnected: true,
      baseUrl: existingUrl,
    };
  }

  // Emit signal for connected clients to show the platform login UI
  broadcastMessage({ type: "show_platform_login" });

  return { showPlatformLogin: true };
}

async function handlePlatformDisconnect(
  _args: RouteHandlerArgs,
): Promise<PlatformDisconnectResponse> {
  // Reject if running inside a platform host
  if (isPlatformRemote()) {
    throw new UnprocessableEntityError(
      "Cannot disconnect from the platform on a platform-hosted assistant.",
    );
  }

  // Check if connected
  const [baseUrl, apiKey] = await Promise.all([
    getSecureKeyAsync(
      credentialKey(
        CREDENTIAL_KEYS.baseUrl.service,
        CREDENTIAL_KEYS.baseUrl.field,
      ),
    ),
    getSecureKeyAsync(
      credentialKey(
        CREDENTIAL_KEYS.apiKey.service,
        CREDENTIAL_KEYS.apiKey.field,
      ),
    ),
  ]);

  if (!baseUrl && !apiKey) {
    throw new UnprocessableEntityError(
      "Not connected to a platform. Nothing to disconnect.\n\n" +
        "Run 'assistant platform status' to check connection state.",
    );
  }

  // Delete all platform credentials
  const keysToDelete = [
    CREDENTIAL_KEYS.baseUrl,
    CREDENTIAL_KEYS.apiKey,
    CREDENTIAL_KEYS.assistantId,
    CREDENTIAL_KEYS.organizationId,
    CREDENTIAL_KEYS.userId,
  ] as const;

  const failedKeys: string[] = [];
  for (const key of keysToDelete) {
    const result = await deleteSecureKeyAsync(
      credentialKey(key.service, key.field),
    );
    if (result === "error") {
      failedKeys.push(`${key.service}:${key.field}`);
    }
  }

  if (failedKeys.length > 0) {
    throw new InternalError(
      `Failed to delete credentials: ${failedKeys.join("; ")}`,
    );
  }

  // Notify connected clients
  broadcastMessage({ type: "platform_disconnected" });

  return {
    disconnected: true,
    previousBaseUrl: baseUrl ?? null,
  };
}

async function handleCallbackRoutesRegister(
  args: RouteHandlerArgs,
): Promise<CallbackRouteRegisterResponse> {
  const { path, type } = (args.body ?? {}) as {
    path?: string;
    type?: string;
  };

  if (!path || typeof path !== "string") {
    throw new BadRequestError("path is required");
  }
  if (!type || typeof type !== "string") {
    throw new BadRequestError("type is required");
  }

  const context = await resolvePlatformCallbackRegistrationContext();
  if (!context.enabled) {
    throw new UnprocessableEntityError(
      "Platform callbacks not available — missing platform base URL, assistant ID, or API key. Run 'assistant platform connect' or ensure credentials are configured.",
    );
  }

  let callbackUrl: string;
  try {
    callbackUrl = await registerCallbackRoute(path, type);
  } catch (err) {
    throw new InternalError(
      `Failed to register callback route: ${(err as Error).message}`,
    );
  }

  return {
    callbackUrl,
    callbackPath: path,
    type,
  };
}

async function handleCallbackRoutesList(
  _args: RouteHandlerArgs,
): Promise<CallbackRoutesListResponse> {
  const routes = (await fetchPlatformJson(
    "/v1/internal/gateway/callback-routes/",
    "callback routes",
  )) as Array<{
    id: string;
    assistant_id: string;
    type: string;
    callback_path: string;
    callback_url: string;
    source_identifier: string | null;
  }>;

  return { routes };
}

async function handlePlatformCredits(
  _args: RouteHandlerArgs,
): Promise<PlatformCreditsResponse> {
  const summary = (await fetchPlatformJson(
    "/v1/organizations/billing/summary/",
    "credit balance",
  )) as {
    settled_balance_usd: string;
    pending_compute_usd: string;
    effective_balance_usd: string;
    is_degraded: boolean;
  };

  return {
    remaining: Number(summary.effective_balance_usd),
    settled: Number(summary.settled_balance_usd),
    pending: Number(summary.pending_compute_usd),
    unit: "USD",
    stale: summary.is_degraded,
    // as_of is response receipt time; add a server as_of field if the billing
    // summary endpoint ever returns one.
    as_of: new Date().toISOString(),
  };
}

/**
 * GET a JSON resource from the platform using the assistant's stored platform
 * credentials. Throws UnprocessableEntityError when credentials are missing and
 * InternalError on transport / non-2xx failures; `label` names the resource in
 * those error messages.
 */
async function fetchPlatformJson(
  path: string,
  label: string,
): Promise<unknown> {
  const context = await resolvePlatformCallbackRegistrationContext();

  if (!context.platformBaseUrl || !context.authHeader) {
    throw new UnprocessableEntityError(
      "Platform credentials not available — run 'assistant platform connect' or set VELLUM_PLATFORM_URL",
    );
  }

  const url = `${context.platformBaseUrl}${path}`;
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
      `Failed to fetch ${label}: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new InternalError(
      `Failed to fetch ${label} (HTTP ${response.status}): ${detail}`,
    );
  }

  return response.json();
}

async function handlePlatformSubscription(
  _args: RouteHandlerArgs,
): Promise<PlatformSubscriptionResponse> {
  const data = (await fetchPlatformJson(
    "/v1/organizations/billing/subscription/",
    "subscription",
  )) as {
    plan_id: "base" | "pro";
    status: string | null;
    renewal_date: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    cancel_at: string | null;
    selected_credit_tier: string | null;
    package: {
      key: string;
      name: string;
      version: number;
      customized: boolean;
    } | null;
    entitlements: { managed_email: boolean; phone_number: boolean };
  };

  return {
    planId: data.plan_id,
    status: data.status,
    renewalDate: data.renewal_date,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    cancelAt: data.cancel_at,
    selectedCreditTier: data.selected_credit_tier,
    package: data.package
      ? {
          key: data.package.key,
          name: data.package.name,
          version: data.package.version,
          customized: data.package.customized,
        }
      : null,
    entitlements: {
      managedEmail: data.entitlements.managed_email,
      phoneNumber: data.entitlements.phone_number,
    },
  };
}

async function handlePlatformPlans(
  _args: RouteHandlerArgs,
): Promise<PlatformPlansResponse> {
  const data = (await fetchPlatformJson(
    "/v1/organizations/billing/plans/",
    "plan catalog",
  )) as { plans?: Array<Record<string, unknown>> };

  return { plans: data.plans ?? [] };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "platform_status",
    endpoint: "platform/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get platform deployment context and connection status",
    description:
      "Aggregates platform context, credentials, assistant ID, and webhook secret. Velay tunnel status is reported separately by gateway_status.",
    tags: ["platform"],
    handler: handlePlatformStatus,
    responseBody: PlatformStatusResponseSchema,
  },
  {
    operationId: "platform_connect",
    endpoint: "platform/connect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Connect to the Vellum Platform",
    description:
      "Checks existing credentials and emits the show_platform_login signal for connected clients to show a login UI.",
    tags: ["platform"],
    handler: handlePlatformConnect,
    responseBody: PlatformConnectResponseSchema,
  },
  {
    operationId: "platform_disconnect",
    endpoint: "platform/disconnect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Disconnect from the Vellum Platform",
    description:
      "Deletes stored platform credentials and emits platform_disconnected signal to connected clients.",
    tags: ["platform"],
    handler: handlePlatformDisconnect,
    responseBody: PlatformDisconnectResponseSchema,
  },
  {
    operationId: "platform_callback_routes_register",
    endpoint: "platform/callback-routes/register",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Register a platform callback route",
    description:
      "Registers a callback route with the platform gateway for inbound provider webhooks.",
    tags: ["platform"],
    handler: handleCallbackRoutesRegister,
    requestBody: CallbackRouteRegisterRequestSchema,
    responseBody: CallbackRouteRegisterResponseSchema,
  },
  {
    operationId: "platform_callback_routes_list",
    endpoint: "platform/callback-routes",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "List registered platform callback routes",
    description:
      "Lists all callback routes registered with the platform for this assistant.",
    tags: ["platform"],
    handler: handleCallbackRoutesList,
    responseBody: CallbackRoutesListResponseSchema,
  },
  {
    operationId: "platform_credits",
    endpoint: "platform/credits",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get the organization's remaining credit balance",
    description:
      "Fetches the org's settled, pending, and effective (remaining) credit balance in USD from the platform billing summary.",
    tags: ["platform"],
    handler: handlePlatformCredits,
    responseBody: PlatformCreditsResponseSchema,
  },
  {
    operationId: "platform_subscription",
    endpoint: "platform/subscription",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get the organization's current plan and subscription state",
    description:
      "Fetches the org's plan (base or pro), subscription status, renewal/period-end dates, cancellation state, selected credit tier, package, and plan-gated entitlements from the platform.",
    tags: ["platform"],
    handler: handlePlatformSubscription,
    responseBody: PlatformSubscriptionResponseSchema,
  },
  {
    operationId: "platform_plans",
    endpoint: "platform/plans",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get the plan catalog with pricing",
    description:
      "Fetches the platform plan catalog: base and pro plans with pricing (in cents), machine/storage/credit tiers, and packages.",
    tags: ["platform"],
    handler: handlePlatformPlans,
    responseBody: PlatformPlansResponseSchema,
  },
];

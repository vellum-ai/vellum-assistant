/**
 * Platform route handlers for the shared HTTP/IPC route table.
 *
 * Serves ten operations:
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
 *   - platform_invoices_list (GET platform/invoices): fetches one
 *     cursor-paginated page of the org's Stripe invoice history.
 *   - platform_invoices_by_id_get (GET platform/invoices/:id): pages through the
 *     invoice list and returns a single invoice by Stripe invoice ID.
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
  NotFoundError,
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

const PlatformInvoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string().nullable(),
  currency: z.string(),
  amount_due: z.number(),
  amount_paid: z.number(),
  amount_remaining: z.number(),
  created: z.number(),
  hosted_invoice_url: z.string().nullable(),
  invoice_pdf: z.string().nullable(),
});
type PlatformInvoice = z.infer<typeof PlatformInvoiceSchema>;

const PlatformInvoicesListResponseSchema = z.object({
  invoices: z.array(PlatformInvoiceSchema),
  has_more: z.boolean(),
});
type PlatformInvoicesListResponse = z.infer<
  typeof PlatformInvoicesListResponseSchema
>;

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

/** Default per-request timeout for platform fetches. */
const PLATFORM_FETCH_TIMEOUT_MS = 10_000;

interface FetchPlatformJsonOptions {
  /**
   * Abort signal from the caller's request. Combined with the per-request
   * timeout so whichever fires first cancels the fetch.
   */
  signal?: AbortSignal;
  /**
   * Per-request timeout override in milliseconds. Defaults to
   * PLATFORM_FETCH_TIMEOUT_MS; callers with an aggregate deadline (the
   * invoices_get cursor walk) pass the remaining budget instead.
   */
  timeoutMs?: number;
  /**
   * When set, an upstream HTTP 400 is surfaced as a BadRequestError combining
   * the response detail with this hint, so caller-correctable input errors
   * (e.g. an invalid pagination cursor) keep their 400 status. When unset, a
   * 400 falls through to the generic InternalError path.
   */
  badRequestHint?: string;
  /**
   * When set, an upstream HTTP 404 resolves to this value instead of the
   * generic InternalError path, for resources where the platform signals
   * "nothing here" with a 404 (e.g. the invoice list for an organization
   * without invoice history). When unset, a 404 stays an InternalError.
   */
  notFoundValue?: unknown;
}

/**
 * GET a JSON resource from the platform using the assistant's stored platform
 * credentials. Throws UnprocessableEntityError when credentials are missing and
 * InternalError on transport / non-2xx failures; `label` names the resource in
 * those error messages. See FetchPlatformJsonOptions for per-call overrides.
 */
async function fetchPlatformJson(
  path: string,
  label: string,
  options?: FetchPlatformJsonOptions,
): Promise<unknown> {
  const context = await resolvePlatformCallbackRegistrationContext();

  if (!context.platformBaseUrl || !context.authHeader) {
    throw new UnprocessableEntityError(
      "Platform credentials not available — run 'assistant platform connect' or set VELLUM_PLATFORM_URL",
    );
  }

  const url = `${context.platformBaseUrl}${path}`;
  const timeout = AbortSignal.timeout(
    options?.timeoutMs ?? PLATFORM_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: context.authHeader,
        Accept: "application/json",
      },
      signal: options?.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
  } catch (err) {
    throw new InternalError(
      `Failed to fetch ${label}: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    if (response.status === 404 && options?.notFoundValue !== undefined) {
      return options.notFoundValue;
    }
    const detail = await response.text().catch(() => "");
    if (response.status === 400 && options?.badRequestHint) {
      throw new BadRequestError(
        `Platform rejected the ${label} request${detail ? `: ${detail}` : ""}. ` +
          options.badRequestHint,
      );
    }
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

/**
 * Fetch one cursor-paginated page of the org's Stripe invoice history from
 * the platform. Pass the previous page's last invoice id as `startingAfter`
 * to fetch the next (older) page.
 */
async function fetchPlatformInvoicesPage(
  startingAfter: string | undefined,
  options?: FetchPlatformJsonOptions,
): Promise<PlatformInvoicesListResponse> {
  let path = "/v1/organizations/billing/invoices/";
  if (startingAfter) {
    path += `?${new URLSearchParams({ starting_after: startingAfter })}`;
  }
  return (await fetchPlatformJson(path, "invoices", {
    ...options,
    // The platform returns 404 for an organization without invoice history;
    // the web client treats that as an empty page
    // (clients/web/src/domains/settings/components/invoices-table.tsx) and
    // the daemon matches it.
    notFoundValue: { invoices: [], has_more: false },
  })) as PlatformInvoicesListResponse;
}

async function handlePlatformInvoicesList(
  args: RouteHandlerArgs,
): Promise<PlatformInvoicesListResponse> {
  const startingAfter = args.queryParams?.starting_after;
  return await fetchPlatformInvoicesPage(startingAfter, {
    signal: args.abortSignal,
    // The platform returns 400 for an invalid or expired starting_after
    // cursor. Only a caller-supplied cursor is caller-correctable, so the
    // hint (and the BadRequestError it triggers) applies just when one was
    // passed; a 400 on a cursor-less request stays an InternalError.
    badRequestHint: startingAfter
      ? "If you passed starting_after, use the id of the last invoice from the previous page."
      : undefined,
  });
}

/**
 * Runaway guard for the invoices_get cursor walk: 25 pages is 2,500
 * invoices at the platform's 100-per-page size.
 */
export const MAX_INVOICE_PAGES = 25;

/**
 * Aggregate wall-clock deadline for the invoices_get cursor walk, matching
 * the gateway IPC client's 30s request timeout. Guards against the walk
 * running long after the caller has given up, since a gateway IPC timeout
 * does not abort the request signal.
 */
export const INVOICE_WALK_DEADLINE_MS = 30_000;

function invoiceWalkTimeoutError(id: string): InternalError {
  return new InternalError(
    `Invoice lookup for "${id}" timed out after ` +
      `${INVOICE_WALK_DEADLINE_MS / 1000} seconds while paging invoice history`,
  );
}

async function handlePlatformInvoiceGet(
  args: RouteHandlerArgs,
): Promise<PlatformInvoice> {
  const id = args.pathParams?.id;
  if (!id) {
    throw new BadRequestError("invoice id is required");
  }

  // There is no per-invoice platform endpoint, so walk the paginated list
  // until the invoice turns up or the cursor is exhausted.
  const walkStartedAt = Date.now();
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_INVOICE_PAGES; pages++) {
    // Stop walking pages once the caller has gone away (gateway IPC timeout,
    // disconnected HTTP client). In-flight fetches are cancelled via the
    // signal passed to fetchPlatformInvoicesPage.
    if (args.abortSignal?.aborted) {
      throw new InternalError(
        `Invoice lookup for "${id}" aborted: caller disconnected`,
      );
    }
    const remainingMs = walkStartedAt + INVOICE_WALK_DEADLINE_MS - Date.now();
    if (remainingMs <= 0) {
      throw invoiceWalkTimeoutError(id);
    }
    // Bound the page fetch by the remaining aggregate budget so a fetch
    // started just under the deadline cannot run the walk past it.
    let page: PlatformInvoicesListResponse;
    try {
      // No badRequestHint: the cursor is internally generated, so an
      // upstream 400 here is an internal failure, not a caller input error.
      page = await fetchPlatformInvoicesPage(cursor, {
        signal: args.abortSignal,
        timeoutMs: Math.min(PLATFORM_FETCH_TIMEOUT_MS, remainingMs),
      });
    } catch (err) {
      // A fetch cancelled by the deadline remainder should read as the
      // walk's aggregate timeout, not a generic network failure.
      if (
        !args.abortSignal?.aborted &&
        Date.now() - walkStartedAt >= INVOICE_WALK_DEADLINE_MS
      ) {
        throw invoiceWalkTimeoutError(id);
      }
      throw err;
    }
    const match = page.invoices.find((invoice) => invoice.id === id);
    if (match) {
      return match;
    }
    if (!page.has_more || page.invoices.length === 0) {
      throw new NotFoundError(
        `Invoice "${id}" not found. Run 'assistant platform invoices list' to see available invoices.`,
      );
    }
    cursor = page.invoices.at(-1)!.id;
  }

  throw new InternalError(
    `Invoice "${id}" not found in the first ${MAX_INVOICE_PAGES} pages of invoice history`,
  );
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
  {
    operationId: "platform_invoices_list",
    endpoint: "platform/invoices",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List one page of the organization's Stripe invoices",
    description:
      "Fetches one page of the org's Stripe invoice history (newest first) from the platform billing invoices endpoint. Amounts are in the currency's minor units. When has_more is true, pass the last invoice's id as starting_after to fetch the next page.",
    tags: ["platform"],
    queryParams: [
      {
        name: "starting_after",
        type: "string",
        required: false,
        description:
          "Cursor: return invoices older than the invoice with this id (from the previous page's last entry).",
      },
    ],
    handler: handlePlatformInvoicesList,
    responseBody: PlatformInvoicesListResponseSchema,
  },
  {
    operationId: "platform_invoices_by_id_get",
    endpoint: "platform/invoices/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a single Stripe invoice by ID",
    description:
      "Pages through the org's invoice list from the platform and returns the invoice matching the given Stripe invoice ID (e.g. in_xxx). 404 if no such invoice.",
    tags: ["platform"],
    handler: handlePlatformInvoiceGet,
    responseBody: PlatformInvoiceSchema,
  },
];

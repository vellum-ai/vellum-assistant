import { z } from "zod";

import { PROVIDER_CATALOG } from "../model-catalog.js";
import { VELLUM_MANAGED_PROVIDER } from "../vellum-model-routing.js";

// ---------------------------------------------------------------------------
// Auth discriminated union (stored in provider_connections.auth as JSON)
// ---------------------------------------------------------------------------

/**
 * Auth configuration stored in the `provider_connections` table.
 *
 * Runtime-supported variants:
 *   - api_key: look up `credential` in vault, inject as bearer/provider header.
 *   - platform: route via Vellum managed proxy; no client-side credential.
 *   - none: no auth (e.g. Ollama running locally).
 *   - oauth_subscription: OAuth-based subscription auth (e.g. ChatGPT Codex).
 *
 * Schema-accepted variants (runtime rejects with a clear "not yet shipped" error):
 *   - service_account: service-account credentials (Vertex AI, Bedrock).
 */
export const AuthSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("api_key"),
      credential: z.string().min(1),
    }),
    z.object({
      type: z.literal("platform"),
    }),
    z.object({
      type: z.literal("none"),
    }),
    z.object({
      type: z.literal("oauth_subscription"),
      credential: z.string().min(1),
    }),
    z.object({
      type: z.literal("service_account"),
      credential: z.string().min(1),
    }),
  ])
  .meta({ id: "Auth" });

export type Auth = z.infer<typeof AuthSchema>;

/**
 * Derive the auth configuration a provider implies when a client omits an
 * explicit `auth` object: keyless catalog providers (`setupMode: "keyless"`,
 * e.g. ollama) need none, the Vellum-managed sentinel routes via the
 * platform proxy, and every other provider authenticates by API key. Returns
 * null when an API key is required but no credential was supplied, so route
 * handlers can reject with a 400. `oauth_subscription` is never derived —
 * the ChatGPT PKCE routes own that connection.
 */
export function deriveAuthForProvider(
  provider: string,
  credential?: string,
): Auth | null {
  if (provider === VELLUM_MANAGED_PROVIDER) {
    return { type: "platform" };
  }
  const entry = PROVIDER_CATALOG.find((p) => p.id === provider);
  if (entry?.setupMode === "keyless") {
    return { type: "none" };
  }
  if (provider === "openai-compatible") {
    // Custom endpoints have no fixed auth story: local servers are usually
    // keyless, hosted ones keyed. Credential presence decides.
    return credential ? { type: "api_key", credential } : { type: "none" };
  }
  return credential ? { type: "api_key", credential } : null;
}

/**
 * The auth a connection dispatches with. The stored auth object is
 * authoritative only where it carries a payload (an api_key credential ref,
 * the oauth_subscription marker, a deliberately keyed keyless provider);
 * the vellum provider IS the managed route, so its auth derives from the
 * provider and the stored value can never mislead dispatch.
 */
export function effectiveConnectionAuth(connection: {
  provider: string;
  auth: Auth;
}): Auth {
  return connection.provider === VELLUM_MANAGED_PROVIDER
    ? { type: "platform" }
    : connection.auth;
}

// ---------------------------------------------------------------------------
// ResolvedAuth — what the dispatcher hands to each adapter
// ---------------------------------------------------------------------------

/**
 * The resolved form of an Auth, produced by the dispatcher before calling
 * an adapter. Adapters are pure functions of (ResolvedAuth, request) → response
 * and never access the vault themselves.
 */
export type ResolvedAuth =
  | { kind: "header"; headers: Record<string, string>; baseUrl?: string }
  | { kind: "runtime_proxy"; route: string }
  | { kind: "none"; baseUrl?: string };

// ---------------------------------------------------------------------------
// Valid provider identifiers — derived from PROVIDER_CATALOG
// ---------------------------------------------------------------------------
//
// PROVIDER_CATALOG (in `model-catalog.ts`) is the single source of truth for
// the closed set of inference-provider identifiers. The list below is
// derived at module load; adding a provider to the catalog automatically
// extends `VALID_CONNECTION_PROVIDERS` and `ConnectionProviderSchema`.
//
// Trade-off: because `PROVIDER_CATALOG` is a runtime value, the
// `ConnectionProvider` static type is `string` rather than a narrow
// literal-string union. Callers that need a narrowed value should parse
// through `ConnectionProviderSchema`, which still rejects unknown
// providers at runtime.

export const VALID_CONNECTION_PROVIDERS: readonly string[] = [
  ...new Set([
    ...PROVIDER_CATALOG.map((p) => p.id),
    // The provider-agnostic Vellum-managed connection stores this sentinel in
    // its `provider` column. The same id owns Vellum-hosted GPU models in the
    // catalog. Keep it allowlisted explicitly so a future catalog rename
    // cannot drop persisted `vellum` rows from the DB loaders.
    VELLUM_MANAGED_PROVIDER,
    // The ChatGPT-subscription row stores the "chatgpt" routing identity in
    // its `provider` column: the row IS the subscription route (auth
    // modality = provider identity), and dispatch derives the openai
    // upstream per-request. Allowlisted explicitly or the DB loaders would
    // drop the persisted row.
    "chatgpt",
  ]),
];

export type ConnectionProvider = string;

/**
 * Name of the single ChatGPT-subscription connection row (created by the
 * ChatGPT sign-in flows). The "chatgpt" routing identity dispatches through
 * this row with an openai upstream.
 */
export const CHATGPT_SUBSCRIPTION_CONNECTION_NAME = "chatgpt-subscription";

/**
 * Provider values that are routing identities rather than adapters: the
 * value names HOW a request routes (vellum = the platform-managed route,
 * chatgpt = the subscription route), and dispatch translates it to a real
 * upstream + connection row per-request (resolveRoutingIdentity). Identity
 * profiles carry no provider_connection; backfill and materialization must
 * not stamp one.
 */
export const ROUTING_IDENTITY_PROVIDERS: ReadonlySet<string> = new Set([
  "vellum",
  "chatgpt",
]);

export const ConnectionProviderSchema = z
  .enum(VALID_CONNECTION_PROVIDERS as readonly [string, ...string[]])
  .meta({ id: "ConnectionProvider" });

// ---------------------------------------------------------------------------
// Per-connection model entries (openai-compatible)
// ---------------------------------------------------------------------------

export const ConnectionModelSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .meta({ id: "ConnectionModel" });
export type ConnectionModel = z.infer<typeof ConnectionModelSchema>;

/**
 * Providers whose connections require an explicit `baseUrl` and non-empty
 * `models` list (openai-compatible endpoints have no fixed upstream, so the
 * user must supply both).
 */
export const PROVIDERS_REQUIRING_BASE_URL_AND_MODELS: ReadonlySet<string> =
  new Set(["openai-compatible"]);

/**
 * Providers that persist a client-supplied `baseUrl`. openai-compatible
 * requires one (see above); ollama has a well-known local default and treats
 * a stored URL as an optional override. Every other provider derives its
 * upstream from the catalog and rejects a client-supplied `baseUrl` so a
 * keyed connection cannot be pointed at an attacker-controlled host.
 */
export const PROVIDERS_ALLOWING_CUSTOM_BASE_URL: ReadonlySet<string> = new Set([
  ...PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
  "ollama",
  "opencode",
]);

// ---------------------------------------------------------------------------
// Full connection shape used by CRUD layer
// ---------------------------------------------------------------------------

export const ProviderConnectionSchema = z
  .object({
    name: z.string().min(1),
    provider: ConnectionProviderSchema,
    auth: AuthSchema,
    label: z.string().min(1).nullable(),
    baseUrl: z.string().url().nullable(),
    models: z.array(ConnectionModelSchema).nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    /**
     * Whether this row is the Vellum-managed connection (`vellum`). Derived from
     * `MANAGED_CONNECTION_NAMES` in `connections.ts` at serialize time; the
     * DB column does not exist. Clients use this to render the read-only
     * "Vellum" badge + view-only editor and to disable the delete affordance
     * without mirroring the canonical name list locally.
     */
    isManaged: z.boolean(),
  })
  .meta({ id: "ProviderConnection" });

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

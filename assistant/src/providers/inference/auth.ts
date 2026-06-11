import { z } from "zod";

import { PROVIDER_CATALOG } from "../model-catalog.js";

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
export const AuthSchema = z.discriminatedUnion("type", [
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
]);

export type Auth = z.infer<typeof AuthSchema>;

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
  | { kind: "none" };

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

export const VALID_CONNECTION_PROVIDERS: readonly string[] =
  PROVIDER_CATALOG.map((p) => p.id);

export type ConnectionProvider = string;

export const ConnectionProviderSchema = z.enum(
  VALID_CONNECTION_PROVIDERS as readonly [string, ...string[]],
);

/**
 * Providers whose connections cannot exist without per-connection
 * `base_url` + `models` — there is no canonical hosted endpoint or model
 * catalog to fall back on. Connection create/update validation enforces the
 * requirement, and boot-time derivation paths (the provider_connections
 * backfill, hatch seeding, and the overlay transplant gate in
 * `mergeDefaultWorkspaceConfig`) skip these providers because a connection
 * cannot be conjured from a bare provider id. Defined here rather than in
 * `connections.ts` so `config/loader.ts` can import it without a module
 * cycle (connections → registry → retry → config/loader).
 */
export const PROVIDERS_REQUIRING_BASE_URL_AND_MODELS: ReadonlySet<string> =
  new Set(["openai-compatible"]);

// ---------------------------------------------------------------------------
// Per-connection model entries (openai-compatible)
// ---------------------------------------------------------------------------

export const ConnectionModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
});
export type ConnectionModel = z.infer<typeof ConnectionModelSchema>;

// ---------------------------------------------------------------------------
// Full connection shape used by CRUD layer
// ---------------------------------------------------------------------------

export const ProviderConnectionSchema = z.object({
  name: z.string().min(1),
  provider: ConnectionProviderSchema,
  auth: AuthSchema,
  label: z.string().min(1).nullable(),
  baseUrl: z.string().url().nullable(),
  models: z.array(ConnectionModelSchema).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /**
   * Whether this row is a Vellum-managed connection (`anthropic-managed`,
   * `openai-managed`, `gemini-managed`). Derived from
   * `MANAGED_CONNECTION_NAMES` in `connections.ts` at serialize time; the
   * DB column does not exist. Clients use this to render the read-only
   * "Vellum" badge + view-only editor and to disable the delete affordance
   * without mirroring the canonical name list locally.
   */
  isManaged: z.boolean(),
});

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

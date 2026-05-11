import { z } from "zod";

// ---------------------------------------------------------------------------
// Auth discriminated union (stored in provider_connections.auth as JSON)
// ---------------------------------------------------------------------------

/**
 * Auth configuration stored in the `provider_connections` table.
 *
 * v1 runtime-supported variants:
 *   - api_key: look up `credential` in vault, inject as bearer/provider header.
 *   - platform: route via Vellum managed proxy; no client-side credential.
 *   - none: no auth (e.g. Ollama running locally).
 *
 * v2 schema-accepted variants (runtime rejects with a clear "not yet shipped" error):
 *   - oauth_subscription: OAuth-based subscription auth.
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
// Valid provider identifiers (code-defined closed set)
// ---------------------------------------------------------------------------

export const VALID_CONNECTION_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
] as const;

export type ConnectionProvider = typeof VALID_CONNECTION_PROVIDERS[number];

export const ConnectionProviderSchema = z.enum(VALID_CONNECTION_PROVIDERS);

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export const ConnectionStatusSchema = z.enum(["active", "disabled"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

// ---------------------------------------------------------------------------
// Full connection shape used by CRUD layer
// ---------------------------------------------------------------------------

export const ProviderConnectionSchema = z.object({
  name: z.string().min(1),
  provider: ConnectionProviderSchema,
  auth: AuthSchema,
  status: ConnectionStatusSchema,
  label: z.string().min(1).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

/**
 * Type aliases for provider-connection SDK responses and a display-name
 * lookup built from the LLM catalog.
 *
 * All CRUD operations use the generated daemon SDK functions directly
 * (`inferenceProviderconnectionsGet`, `inferenceProviderconnectionsPost`,
 * etc.) — this module only re-exports convenience types and the
 * credential-entry parser so consumers stay concise.
 */

import { PROVIDER_DISPLAY_NAMES as CATALOG_PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import type {
  InferenceProviderconnectionsGetResponse,
  InferenceProviderconnectionsPostData,
  InferenceProviderconnectionsByNamePatchData,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Type aliases — derived from generated daemon SDK types
// ---------------------------------------------------------------------------

/** A single provider connection, as returned by the daemon list endpoint. */
export type ProviderConnection =
  InferenceProviderconnectionsGetResponse["connections"][number];

/** Provider identifier enum (generated from the daemon's Zod schema). */
export type ConnectionProvider = ProviderConnection["provider"];

/** Discriminated-union auth shape on a connection. */
export type Auth = ProviderConnection["auth"];

/** Model entry on a connection (nullable array element). */
export type ConnectionModel = NonNullable<ProviderConnection["models"]>[number];

/** Body shape for POST /inference/provider-connections. */
export type CreateConnectionInput =
  InferenceProviderconnectionsPostData["body"];

/** Body shape for PATCH /inference/provider-connections/:name. */
export type UpdateConnectionInput =
  InferenceProviderconnectionsByNamePatchData["body"];

// ---------------------------------------------------------------------------
// Display-name lookup
// ---------------------------------------------------------------------------

export const PROVIDER_DISPLAY_NAMES: Record<ConnectionProvider, string> =
  buildConnectionProviderDisplayNames();

function buildConnectionProviderDisplayNames(): Record<
  ConnectionProvider,
  string
> {
  const lookup = {
    anthropic: CATALOG_PROVIDER_DISPLAY_NAMES.anthropic,
    openai: CATALOG_PROVIDER_DISPLAY_NAMES.openai,
    gemini: CATALOG_PROVIDER_DISPLAY_NAMES.gemini,
    ollama: CATALOG_PROVIDER_DISPLAY_NAMES.ollama,
    fireworks: CATALOG_PROVIDER_DISPLAY_NAMES.fireworks,
    openrouter: CATALOG_PROVIDER_DISPLAY_NAMES.openrouter,
    "openai-compatible":
      CATALOG_PROVIDER_DISPLAY_NAMES["openai-compatible"],
    minimax: CATALOG_PROVIDER_DISPLAY_NAMES.minimax,
  } satisfies Record<ConnectionProvider, string | undefined>;
  const out = {} as Record<ConnectionProvider, string>;
  for (const provider of Object.keys(lookup) as ConnectionProvider[]) {
    const label = lookup[provider];
    if (label === undefined) {
      throw new Error(
        `provider-connections-client: catalog missing displayName for ` +
          `ConnectionProvider "${provider}".`,
      );
    }
    out[provider] = label;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feature-flag filter
// ---------------------------------------------------------------------------

export function filterFlaggedConnections(
  connections: ProviderConnection[],
  openAICompatibleEndpointsEnabled: boolean,
): ProviderConnection[] {
  if (openAICompatibleEndpointsEnabled) return connections;
  return connections.filter((c) => c.provider !== "openai-compatible");
}

// ---------------------------------------------------------------------------
// Credential-entry parser (transforms secrets list into service/field pairs)
// ---------------------------------------------------------------------------

export interface CredentialEntry {
  service: string;
  field: string;
}

/** A single entry from the daemon's `GET /secrets` response. */
type SecretEntry = SecretsGetResponse["secrets"][number];

/**
 * Parse a typed secrets-list response into credential entries suitable for
 * the provider-editor's Advanced dropdown.
 */
export function parseCredentialEntries(
  entries: readonly SecretEntry[],
): CredentialEntry[] {
  const results: CredentialEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "api_key") {
      results.push({ service: entry.name, field: "api_key" });
    } else if (entry.type === "credential") {
      const colonIdx = entry.name.lastIndexOf(":");
      if (colonIdx >= 0) {
        const service = entry.name.slice(0, colonIdx);
        const field = entry.name.slice(colonIdx + 1);
        if (service && field) results.push({ service, field });
      }
    }
  }
  return results;
}

/**
 * Display-name lookup, convenience type aliases for request bodies,
 * and the credential-entry parser for provider connections.
 *
 * All CRUD operations use the generated daemon SDK functions directly.
 * Named types (`ProviderConnection`, `ConnectionProvider`, `Auth`,
 * `ConnectionModel`) are exported by the generated SDK — import them
 * from `@/generated/daemon/types.gen` at each call site.
 */

import { PROVIDER_DISPLAY_NAMES as CATALOG_PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import type {
  ConnectionProvider,
  InferenceProviderconnectionsPostData,
  InferenceProviderconnectionsByNamePatchData,
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Convenience type aliases for request bodies (generated names are unwieldy)
// ---------------------------------------------------------------------------

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
// Feature-flag filter (retained for call-site compatibility)
// ---------------------------------------------------------------------------

export function filterFlaggedConnections(
  connections: ProviderConnection[],
): ProviderConnection[] {
  return connections;
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

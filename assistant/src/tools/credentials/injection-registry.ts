/**
 * Credential injection template registry.
 *
 * Maps well-known credential service/field pairs to their default injection
 * templates and allowed domains.  When a credential is stored (via the daemon
 * config handler *or* via the HTTP secret route), the registry is consulted
 * so that the proxy injection metadata is written regardless of which code
 * path provisioned the credential.
 *
 * To add a new credential type with proxy injection support, add an entry
 * to {@link INJECTION_REGISTRY} below.
 */

import type { CredentialInjectionTemplate } from "./policy-types.js";

// ---------------------------------------------------------------------------
// Registry entry type
// ---------------------------------------------------------------------------

export interface InjectionRegistryEntry {
  /** Domains the credential is scoped to. */
  allowedDomains: string[];
  /** Templates describing how to inject the credential into proxied requests. */
  injectionTemplates: CredentialInjectionTemplate[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Static registry of well-known credential types that require proxy injection.
 *
 * Key format: `{service}/{field}` (matches the credential ref format used by
 * skill definitions, e.g. `credential_ids: ["slack_channel/bot_token"]`).
 */
const INJECTION_REGISTRY: ReadonlyMap<string, InjectionRegistryEntry> = new Map(
  [
    [
      "slack_channel/bot_token",
      {
        allowedDomains: ["slack.com"],
        injectionTemplates: [
          {
            hostPattern: "slack.com",
            injectionType: "header" as const,
            headerName: "Authorization",
            valuePrefix: "Bearer ",
          },
        ],
      },
    ],
  ],
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up the default injection metadata for a credential type.
 *
 * @returns The registry entry if a well-known injection configuration exists,
 *          or `undefined` if the credential type has no registered injection.
 */
export function getInjectionRegistryEntry(
  service: string,
  field: string,
): InjectionRegistryEntry | undefined {
  return INJECTION_REGISTRY.get(`${service}/${field}`);
}

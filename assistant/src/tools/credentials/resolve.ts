/**
 * Credential resolver - maps between opaque IDs, service/field pairs,
 * and storage locators.
 *
 * This decouples external credential references from the underlying
 * secure key naming convention.
 *
 * Supports two credential backends:
 * 1. **Manual credentials** — stored in the JSON metadata store with secrets
 *    at `credential/{service}/{field}`.
 * 2. **OAuth connections** — stored in SQLite (`oauth_connections`) with
 *    access tokens at `oauth_connection/{connId}/access_token`. Injection
 *    templates come from `PROVIDER_BEHAVIORS` in `provider-behaviors.ts`.
 *    These are synthesized as virtual `ResolvedCredential` objects so the
 *    proxy can inject OAuth tokens transparently.
 */

import {
  credentialKey,
  oauthConnectionAccessTokenPath,
} from "@vellumai/credential-storage";

import {
  getActiveConnection,
  getConnection,
  listConnections,
  type OAuthConnectionRow,
} from "../../oauth/oauth-store.js";
import { getProviderBehavior } from "../../oauth/provider-behaviors.js";
import { matchHostPattern } from "./host-pattern-match.js";
import {
  type CredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
} from "./metadata-store.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";

export interface ResolvedCredential {
  credentialId: string;
  service: string;
  field: string;
  /** The key used in the secure key backend. */
  storageKey: string;
  /** Human-friendly alias, if set. */
  alias?: string;
  /** Injection templates for proxied requests. */
  injectionTemplates: CredentialInjectionTemplate[];
  metadata: CredentialMetadata;
  /**
   * When true, this credential is backed by an OAuth connection rather than
   * a manual credential. The `storageKey` points to
   * `oauth_connection/{connId}/access_token` and the token may need proactive
   * refresh before injection.
   */
  isOAuthConnection?: boolean;
  /** The OAuth connection ID, set when `isOAuthConnection` is true. */
  oauthConnectionId?: string;
}

/** Quick check for UUID-shaped strings (8-4-4-4-12 hex). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isPlausibleUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function toResolved(metadata: CredentialMetadata): ResolvedCredential {
  return {
    credentialId: metadata.credentialId,
    service: metadata.service,
    field: metadata.field,
    storageKey: credentialKey(metadata.service, metadata.field),
    alias: metadata.alias,
    injectionTemplates: metadata.injectionTemplates ?? [],
    metadata,
  };
}

/**
 * Synthesize a `ResolvedCredential` from an active OAuth connection and its
 * provider behavior. Returns `undefined` if the provider has no injection
 * templates defined.
 */
function oauthConnectionToResolved(
  conn: OAuthConnectionRow,
): ResolvedCredential | undefined {
  const behavior = getProviderBehavior(conn.providerKey);
  const templates = behavior?.injectionTemplates;
  if (!templates || templates.length === 0) return undefined;

  // Build a synthetic CredentialMetadata so existing code that reads
  // `resolved.metadata` doesn't break.
  const syntheticMetadata: CredentialMetadata = {
    credentialId: conn.id,
    service: conn.providerKey,
    field: "oauth_access_token",
    allowedTools: [],
    allowedDomains: [],
    injectionTemplates: templates,
    createdAt: typeof conn.createdAt === "number" ? conn.createdAt : Date.now(),
    updatedAt: typeof conn.updatedAt === "number" ? conn.updatedAt : Date.now(),
  };

  return {
    credentialId: conn.id,
    service: conn.providerKey,
    field: "oauth_access_token",
    storageKey: oauthConnectionAccessTokenPath(conn.id),
    alias: conn.accountInfo ?? undefined,
    injectionTemplates: templates,
    metadata: syntheticMetadata,
    isOAuthConnection: true,
    oauthConnectionId: conn.id,
  };
}

/**
 * Resolve a credential by service and field.
 * Returns the resolved credential or undefined if not found.
 */
export function resolveByServiceField(
  service: string,
  field: string,
): ResolvedCredential | undefined {
  const metadata = getCredentialMetadata(service, field);
  if (metadata) return toResolved(metadata);

  // Fall back to OAuth connection: treat the service as a provider key
  // (e.g. "integration:linear") with the synthetic field "oauth_access_token".
  if (field === "oauth_access_token") {
    try {
      const conn = getActiveConnection(service);
      if (conn) return oauthConnectionToResolved(conn);
    } catch {
      // DB not available
    }
  }

  return undefined;
}

/**
 * Resolve a credential by its opaque ID.
 * Returns the resolved credential or undefined if not found.
 */
export function resolveById(
  credentialId: string,
): ResolvedCredential | undefined {
  // Try manual credential metadata first
  const metadata = getCredentialMetadataById(credentialId);
  if (metadata) return toResolved(metadata);

  // Fall back to OAuth connection by UUID.
  // Only attempt the DB lookup for plausible UUIDs to avoid spurious queries
  // for service/field-style refs like "fal/api_key".
  if (isPlausibleUuid(credentialId)) {
    try {
      const conn = getConnection(credentialId);
      if (conn && conn.status === "active") {
        return oauthConnectionToResolved(conn);
      }
    } catch {
      // DB not available (e.g. during tests or early startup)
    }
  }

  return undefined;
}

/**
 * Resolve a credential reference that may be either a UUID or a "service/field" string.
 *
 * Resolution order:
 * 1. Try as UUID via resolveById (checks both manual credentials and OAuth connections)
 * 2. If not found, try parsing as "service/field" via resolveByServiceField
 *
 * Returns undefined for malformed refs (e.g. no slash, too many slashes, empty segments)
 * and for refs that don't match any stored credential.
 */
export function resolveCredentialRef(
  ref: string,
): ResolvedCredential | undefined {
  if (!ref || ref.trim().length === 0) return undefined;

  // Try as UUID first
  const byId = resolveById(ref);
  if (byId) return byId;

  // Try as service/field
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= ref.length - 1) return undefined;
  // Reject refs with more than one slash (e.g. "fal/api/key")
  if (ref.indexOf("/", slashIndex + 1) !== -1) return undefined;

  const service = ref.slice(0, slashIndex);
  const field = ref.slice(slashIndex + 1);
  return resolveByServiceField(service, field);
}

/**
 * Find all credentials whose injection templates match a given hostname.
 * Returns resolved credentials with their `injectionTemplates` filtered
 * to only the matching entries.
 *
 * Checks both manual credentials and active OAuth connections.
 */
export function resolveForDomain(hostname: string): ResolvedCredential[] {
  const results: ResolvedCredential[] = [];
  const seenIds = new Set<string>();

  // 1. Manual credentials from metadata store
  for (const meta of listCredentialMetadata()) {
    const templates = meta.injectionTemplates ?? [];
    const matching = templates.filter(
      (t) =>
        matchHostPattern(hostname, t.hostPattern, {
          includeApexForWildcard: true,
        }) !== "none",
    );
    if (matching.length === 0) continue;
    seenIds.add(meta.credentialId);
    results.push({
      ...toResolved(meta),
      injectionTemplates: matching,
    });
  }

  // 2. Active OAuth connections with injection templates
  for (const conn of listActiveOAuthConnectionsWithTemplates()) {
    if (seenIds.has(conn.id)) continue;
    const behavior = getProviderBehavior(conn.providerKey);
    const templates = behavior?.injectionTemplates ?? [];
    const matching = templates.filter(
      (t) =>
        matchHostPattern(hostname, t.hostPattern, {
          includeApexForWildcard: true,
        }) !== "none",
    );
    if (matching.length === 0) continue;
    const resolved = oauthConnectionToResolved(conn);
    if (!resolved) continue;
    results.push({
      ...resolved,
      injectionTemplates: matching,
    });
  }

  return results;
}

/**
 * List all active OAuth connections that have injection templates defined
 * in their provider behavior. Used by the proxy to auto-discover OAuth
 * credentials for injection.
 */
export function listActiveOAuthConnectionsWithTemplates(): OAuthConnectionRow[] {
  try {
    return listConnections()
      .filter((c) => c.status === "active")
      .filter((c) => {
        const behavior = getProviderBehavior(c.providerKey);
        return (
          behavior?.injectionTemplates && behavior.injectionTemplates.length > 0
        );
      });
  } catch {
    // DB not available (e.g. during tests or early startup)
    return [];
  }
}

/**
 * Credential resolver — maps between opaque IDs, service/field pairs,
 * and storage locators.
 *
 * This decouples external credential references from the underlying
 * secure key naming convention.
 */

import { credentialKey } from "@vellumai/credential-storage";

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
 * Resolve a credential by service and field.
 * Returns the resolved credential or undefined if not found.
 */
export function resolveByServiceField(
  service: string,
  field: string,
): ResolvedCredential | undefined {
  const metadata = getCredentialMetadata(service, field);
  if (!metadata) return undefined;
  return toResolved(metadata);
}

/**
 * Resolve a credential by its opaque ID.
 * Returns the resolved credential or undefined if not found.
 */
export function resolveById(
  credentialId: string,
): ResolvedCredential | undefined {
  const metadata = getCredentialMetadataById(credentialId);
  if (!metadata) return undefined;
  return toResolved(metadata);
}

/**
 * Resolve a credential reference that may be either a UUID or a "service/field" string.
 *
 * Resolution order:
 * 1. Try as UUID via resolveById
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
 */
export function resolveForDomain(hostname: string): ResolvedCredential[] {
  const all = listCredentialMetadata();
  const results: ResolvedCredential[] = [];

  for (const meta of all) {
    const templates = meta.injectionTemplates ?? [];
    const matching = templates.filter(
      (t) =>
        matchHostPattern(hostname, t.hostPattern, {
          includeApexForWildcard: true,
        }) !== "none",
    );
    if (matching.length === 0) continue;
    results.push({
      ...toResolved(meta),
      injectionTemplates: matching,
    });
  }

  return results;
}

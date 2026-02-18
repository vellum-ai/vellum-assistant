/**
 * Credential resolver — maps between opaque IDs, service/field pairs,
 * and storage locators.
 *
 * This decouples external credential references from the underlying
 * secure key naming convention.
 */

import {
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  type CredentialMetadata,
} from './metadata-store.js';
import type { CredentialInjectionTemplate } from './policy-types.js';
import { minimatch } from 'minimatch';

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
    storageKey: `credential:${metadata.service}:${metadata.field}`,
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
 * Find all credentials whose injection templates match a given hostname.
 * Returns resolved credentials with their `injectionTemplates` filtered
 * to only the matching entries.
 */
export function resolveForDomain(
  hostname: string,
): ResolvedCredential[] {
  const all = listCredentialMetadata();
  const results: ResolvedCredential[] = [];

  for (const meta of all) {
    const templates = meta.injectionTemplates ?? [];
    const matching = templates.filter((t) =>
      minimatch(hostname, t.hostPattern, { nocase: true }),
    );
    if (matching.length === 0) continue;
    results.push({
      ...toResolved(meta),
      injectionTemplates: matching,
    });
  }

  return results;
}

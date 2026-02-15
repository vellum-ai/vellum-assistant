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
  type CredentialMetadata,
} from './metadata-store.js';

export interface ResolvedCredential {
  credentialId: string;
  service: string;
  field: string;
  /** The key used in the secure key backend. */
  storageKey: string;
  metadata: CredentialMetadata;
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

  return {
    credentialId: metadata.credentialId,
    service: metadata.service,
    field: metadata.field,
    storageKey: `credential:${metadata.service}:${metadata.field}`,
    metadata,
  };
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

  return {
    credentialId: metadata.credentialId,
    service: metadata.service,
    field: metadata.field,
    storageKey: `credential:${metadata.service}:${metadata.field}`,
    metadata,
  };
}

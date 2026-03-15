/**
 * Credential metadata store.
 *
 * Thin wrapper around the portable StaticCredentialMetadataStore from
 * @vellumai/credential-storage. Wires in the platform-specific data
 * directory and preserves the existing module-level API so that call
 * sites throughout the assistant daemon do not need to change.
 *
 * OAuth-specific fields (expiresAt, grantedScopes, oauth2TokenUrl,
 * oauth2ClientId, oauth2TokenEndpointAuthMethod, hasRefreshToken) are now
 * exclusively managed by the SQLite oauth-store and have been removed
 * from this interface as of v5.
 */

import { join } from "node:path";

import { StaticCredentialMetadataStore } from "@vellumai/credential-storage";

import { getDataDir } from "../../util/platform.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";

/**
 * CredentialMetadata extends the shared StaticCredentialRecord with
 * assistant-specific injection template fields (composeWith, valueTransform).
 * Structurally compatible — the shared store persists all fields as-is.
 */
export interface CredentialMetadata {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  usageDescription?: string;
  /** Human-friendly name for this credential (e.g. "fal-primary"). */
  alias?: string;
  /** Templates describing how to inject this credential into proxied requests. */
  injectionTemplates?: CredentialInjectionTemplate[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Singleton store instance
// ---------------------------------------------------------------------------

/**
 * Lazily initialised store instance. The path is determined on first access
 * (or overridden via `_setMetadataPath` for tests).
 */
let _store: StaticCredentialMetadataStore | undefined;
let _overridePath: string | null = null;

function getStore(): StaticCredentialMetadataStore {
  if (!_store) {
    const path =
      _overridePath ?? join(getDataDir(), "credentials", "metadata.json");
    _store = new StaticCredentialMetadataStore(path);
  }
  return _store;
}

// ---------------------------------------------------------------------------
// Public API — unchanged signatures, delegates to shared store
// ---------------------------------------------------------------------------

/**
 * Throws if the metadata file has an unrecognized version.
 * Call this before performing irreversible keychain operations
 * so the operation fails cleanly before any side effects.
 */
export function assertMetadataWritable(): void {
  getStore().assertWritable();
}

/**
 * Create or update a credential metadata record.
 * If a record with the same service+field exists, it is updated.
 */
export function upsertCredentialMetadata(
  service: string,
  field: string,
  policy?: {
    allowedTools?: string[];
    allowedDomains?: string[];
    usageDescription?: string;
    /** Pass `null` to explicitly clear a previously-set alias. */
    alias?: string | null;
    /** Pass `null` to explicitly clear injection templates. */
    injectionTemplates?: CredentialInjectionTemplate[] | null;
  },
): CredentialMetadata {
  return getStore().upsert(service, field, policy) as CredentialMetadata;
}

/**
 * Get metadata for a credential by service and field.
 */
export function getCredentialMetadata(
  service: string,
  field: string,
): CredentialMetadata | undefined {
  return getStore().getByServiceField(service, field) as
    | CredentialMetadata
    | undefined;
}

/**
 * Get metadata for a credential by its opaque ID.
 */
export function getCredentialMetadataById(
  credentialId: string,
): CredentialMetadata | undefined {
  return getStore().getById(credentialId) as CredentialMetadata | undefined;
}

/**
 * List all credential metadata records.
 */
export function listCredentialMetadata(): CredentialMetadata[] {
  return getStore().list() as CredentialMetadata[];
}

/**
 * Delete metadata for a credential.
 */
export function deleteCredentialMetadata(
  service: string,
  field: string,
): boolean {
  return getStore().delete(service, field);
}

/** @internal Test-only: override the metadata file path. */
export function _setMetadataPath(path: string | null): void {
  _overridePath = path;
  // Reset the store so it picks up the new path
  if (_store) {
    if (path) {
      _store.setPath(path);
    } else {
      _store = undefined;
    }
  }
}

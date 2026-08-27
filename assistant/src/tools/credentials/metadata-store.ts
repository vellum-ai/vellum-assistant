/**
 * Credential metadata store.
 *
 * Reads stay on the workspace `metadata.json` file (sync). When a CES
 * record backend is injected, upserts and deletes also write-through to
 * CES so the CES catalog stays current.
 *
 * Hydrate copies leftover workspace rows into CES. The workspace file
 * stays in place.
 *
 * Tests: `_setMetadataPath` keeps the file-backed store and skips CES
 * write-through.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  credentialKey,
  StaticCredentialMetadataStore,
} from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../../security/ces-rpc-record-backend.js";
import { getLogger } from "../../util/logger.js";
import { getDataDir } from "../../util/platform.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";

const log = getLogger("credential-metadata-store");

/**
 * CredentialMetadata extends the shared StaticCredentialRecord with
 * assistant-specific injection template fields (composeWith, valueTransform).
 * Structurally compatible - the shared store persists all fields as-is.
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

let _store: StaticCredentialMetadataStore | undefined;
let _overridePath: string | null = null;
let _recordBackend: CredentialRecordBackend | undefined;

function getStore(): StaticCredentialMetadataStore {
  if (!_store) {
    const path = _overridePath ?? defaultMetadataPath();
    _store = new StaticCredentialMetadataStore(path);
  }
  return _store;
}

function toRecord(metadata: CredentialMetadata): CredentialRecord {
  return {
    credentialId: metadata.credentialId,
    service: metadata.service,
    field: metadata.field,
    allowedTools: metadata.allowedTools,
    allowedDomains: metadata.allowedDomains,
    usageDescription: metadata.usageDescription,
    alias: metadata.alias,
    injectionTemplates: metadata.injectionTemplates,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

async function persistCredentialMetadata(
  metadata: CredentialMetadata,
): Promise<void> {
  if (!_recordBackend || _overridePath) {
    return;
  }
  const account = credentialKey(metadata.service, metadata.field);
  const ok = await _recordBackend.set(account, toRecord(metadata));
  if (!ok) {
    log.warn(
      { service: metadata.service, field: metadata.field },
      "Failed to persist credential record to CES",
    );
  }
}

export function setCredentialRecordBackend(
  backend: CredentialRecordBackend | undefined,
): void {
  _recordBackend = backend;
}

function defaultMetadataPath(): string {
  return join(getDataDir(), "credentials", "metadata.json");
}

/**
 * Copy leftover workspace metadata.json rows that CES does not already
 * have. Existing CES records win. The workspace file stays in place.
 * Reads continue from the file.
 */
export async function hydrateCredentialRecordsFromCes(): Promise<void> {
  if (!_recordBackend || _overridePath) {
    return;
  }
  if (!_recordBackend.isAvailable()) {
    log.warn("CES record backend unavailable; skipping metadata.json import");
    return;
  }

  const filePath = defaultMetadataPath();
  if (!existsSync(filePath)) {
    return;
  }

  const fileStore = new StaticCredentialMetadataStore(filePath);
  const localRecords = fileStore.list() as CredentialMetadata[];
  if (localRecords.length === 0) {
    return;
  }

  const existing = await _recordBackend.list();
  if (existing === null) {
    log.warn("CES record list failed; skipping metadata.json import");
    return;
  }
  const existingAccounts = new Set(existing.map((entry) => entry.account));
  const missing = localRecords.filter((record) => {
    return !existingAccounts.has(credentialKey(record.service, record.field));
  });
  if (missing.length === 0) {
    return;
  }

  const results =
    (await _recordBackend.bulkSet(
      missing.map((record) => ({
        account: credentialKey(record.service, record.field),
        record: toRecord(record),
      })),
    )) ?? [];
  const imported =
    results.length === missing.length && results.every((entry) => entry.ok);
  if (!imported) {
    log.warn(
      { expected: missing.length, results },
      "CES import of metadata.json incomplete",
    );
    return;
  }
  log.info(
    { count: missing.length },
    "Imported workspace credential metadata.json into CES",
  );
}

// ---------------------------------------------------------------------------
// Public API - unchanged signatures, delegates to shared store
// ---------------------------------------------------------------------------

/**
 * Throws if the metadata file has an unrecognized version.
 * Call this before performing irreversible credential store operations
 * so the operation fails cleanly before any side effects.
 */
export function assertMetadataWritable(): void {
  getStore().assertWritable();
}

/**
 * Create or update a credential metadata record.
 * If a record with the same service+field exists, it is updated.
 * When a CES record backend is attached, the upsert also write-throughs
 * to CES.
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
  const record = getStore().upsert(service, field, policy) as CredentialMetadata;
  void persistCredentialMetadata(record);
  return record;
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
  const deleted = getStore().delete(service, field);
  if (deleted && _recordBackend && !_overridePath) {
    void _recordBackend.delete(credentialKey(service, field));
  }
  return deleted;
}

/** @internal Test-only: override the metadata file path. */
export function _setMetadataPath(path: string | null): void {
  _overridePath = path;
  if (_store) {
    if (path) {
      _store.setPath(path);
    } else {
      _store = undefined;
    }
  }
}

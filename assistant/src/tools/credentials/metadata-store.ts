/**
 * Credential metadata store.
 *
 * Production: CES owns identity + policy records. This module keeps a
 * synchronous in-process cache so existing call sites stay sync, and
 * write-through to CES when a record backend is injected.
 *
 * Tests: `_setMetadataPath` keeps the file-backed store.
 *
 * On hydrate, any leftover workspace `metadata.json` is copied into CES
 * (overwriting CES rows so workspace migrations that ran before CES
 * connect win). The file is deleted after CES lists those records back.
 */

import { existsSync, rmSync } from "node:fs";
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

function defaultMetadataPath(): string {
  return join(getDataDir(), "credentials", "metadata.json");
}

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

async function persistRecord(metadata: CredentialMetadata): Promise<void> {
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

/** Await CES write-through for a record already in the local cache. */
export async function persistCredentialMetadata(
  metadata: CredentialMetadata,
): Promise<void> {
  await persistRecord(metadata);
}

export function setCredentialRecordBackend(
  backend: CredentialRecordBackend | undefined,
): void {
  _recordBackend = backend;
}

/**
 * Load CES records into the in-process cache. If a leftover workspace
 * metadata.json exists, it is uploaded to CES first (source of truth for
 * this boot). The file is deleted only after CES lists those records back.
 */
export async function hydrateCredentialRecordsFromCes(): Promise<void> {
  if (!_recordBackend || _overridePath) {
    return;
  }
  if (!_recordBackend.isAvailable()) {
    log.warn("CES record backend unavailable; leaving metadata.json in place");
    return;
  }

  const filePath = defaultMetadataPath();
  let localRecords: CredentialMetadata[] = [];
  if (existsSync(filePath)) {
    const fileStore = new StaticCredentialMetadataStore(filePath);
    localRecords = fileStore.list() as CredentialMetadata[];
    if (localRecords.length > 0) {
      const results = await _recordBackend.bulkSet(
        localRecords.map((record) => ({
          account: credentialKey(record.service, record.field),
          record: toRecord(record),
        })),
      );
      const imported =
        results.length === localRecords.length &&
        results.every((entry) => entry.ok);
      if (!imported) {
        log.warn(
          { expected: localRecords.length, results },
          "CES import of metadata.json incomplete; keeping the workspace file",
        );
        getStore().useMemory(localRecords);
        return;
      }
    }
  }

  const remote = await _recordBackend.list();
  if (remote === null) {
    log.warn(
      "CES record list failed; keeping leftover metadata.json and existing cache",
    );
    if (localRecords.length > 0) {
      getStore().useMemory(localRecords);
    }
    return;
  }

  if (localRecords.length > 0) {
    const remoteAccounts = new Set(remote.map((entry) => entry.account));
    const confirmed = localRecords.every((record) =>
      remoteAccounts.has(credentialKey(record.service, record.field)),
    );
    if (!confirmed) {
      log.warn(
        {
          local: localRecords.length,
          remote: remote.length,
        },
        "CES list is missing imported metadata.json rows; keeping the workspace file",
      );
      getStore().useMemory(localRecords);
      return;
    }
  }

  if (existsSync(filePath)) {
    try {
      rmSync(filePath, { force: true });
      log.info(
        { count: localRecords.length },
        "Retired workspace credential metadata.json after CES import",
      );
    } catch (err) {
      log.warn({ err }, "Failed to delete workspace metadata.json");
    }
  }

  const store = getStore();
  store.useMemory(remote.map((entry) => entry.record));
  log.info(
    { count: remote.length },
    "Hydrated credential records from CES",
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
  void persistRecord(record);
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

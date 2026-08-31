/**
 * Credential metadata store.
 *
 * Production: CES owns identity + policy records. This module keeps a
 * synchronous in-process cache so existing call sites stay sync, and
 * write-throughs to CES when a record backend is injected.
 *
 * The cache is filled lazily: the first catalog read or write starts a
 * single-flight CES `list()`. Leftover workspace `metadata.json` is not
 * read. CES import (003) may leave that file in place; this module
 * ignores it.
 *
 * Tests: `_setMetadataPath` keeps the file-backed store and skips CES
 * load and write-through.
 */

import {
  credentialKey,
  StaticCredentialMetadataStore,
} from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../../security/ces-rpc-record-backend.js";
import { getLogger } from "../../util/logger.js";
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

const CES_MEMORY_PATH = "ces-in-memory-credential-metadata";

let _store: StaticCredentialMetadataStore | undefined;
let _overridePath: string | null = null;
let _recordBackend: CredentialRecordBackend | undefined;
let _cesRecordsLoaded = false;
let _cesLoad: Promise<void> | undefined;
let _cesLoadGeneration = 0;

function getStore(): StaticCredentialMetadataStore {
  if (!_store) {
    if (_overridePath) {
      _store = new StaticCredentialMetadataStore(_overridePath);
    } else {
      _store = new StaticCredentialMetadataStore(CES_MEMORY_PATH);
      _store.useMemory([]);
    }
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

function resetCesLoad(): void {
  _cesRecordsLoaded = false;
  _cesLoad = undefined;
  _cesLoadGeneration += 1;
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
  resetCesLoad();
}

function ensureCesRecordsLoaded(): Promise<void> {
  if (_overridePath || !_recordBackend || _cesRecordsLoaded) {
    return Promise.resolve();
  }
  if (_cesLoad) {
    return _cesLoad;
  }
  const generation = _cesLoadGeneration;
  _cesLoad = loadCesRecords(generation).finally(() => {
    if (_cesLoadGeneration === generation) {
      _cesLoad = undefined;
    }
  });
  return _cesLoad;
}

async function loadCesRecords(generation: number): Promise<void> {
  try {
    if (!_recordBackend || _overridePath || generation !== _cesLoadGeneration) {
      return;
    }
    let available = false;
    try {
      available = _recordBackend.isAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      log.warn("CES record backend unavailable; keeping in-process cache");
      return;
    }

    const remote = await _recordBackend.list();
    if (generation !== _cesLoadGeneration) {
      return;
    }
    if (remote === null) {
      log.warn("CES record list failed; keeping in-process cache");
      return;
    }

    const store = getStore();
    const localByAccount = new Map(
      store
        .list()
        .map((record) => [credentialKey(record.service, record.field), record]),
    );
    const merged = remote.map((entry) => {
      const local = localByAccount.get(entry.account);
      if (local) {
        localByAccount.delete(entry.account);
        return local;
      }
      return entry.record;
    });
    for (const leftover of localByAccount.values()) {
      merged.push(leftover);
    }
    store.useMemory(merged);
    _cesRecordsLoaded = true;
    log.info({ count: remote.length }, "Loaded credential records from CES");
  } catch (err) {
    log.warn({ err }, "CES record load failed");
  }
}

function touchCesCache(): void {
  void ensureCesRecordsLoaded();
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
  touchCesCache();
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
  touchCesCache();
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
  touchCesCache();
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
  touchCesCache();
  return getStore().getById(credentialId) as CredentialMetadata | undefined;
}

/**
 * List all credential metadata records.
 */
export function listCredentialMetadata(): CredentialMetadata[] {
  touchCesCache();
  return getStore().list() as CredentialMetadata[];
}

/**
 * Delete metadata for a credential.
 */
export function deleteCredentialMetadata(
  service: string,
  field: string,
): boolean {
  touchCesCache();
  const deleted = getStore().delete(service, field);
  if (deleted && _recordBackend && !_overridePath) {
    void _recordBackend.delete(credentialKey(service, field));
  }
  return deleted;
}

/** @internal Test-only: wait for the in-flight CES list to populate the cache. */
export function _ensureCesRecordsLoaded(): Promise<void> {
  return ensureCesRecordsLoaded();
}

/** @internal Test-only: override the metadata file path. */
export function _setMetadataPath(path: string | null): void {
  _overridePath = path;
  resetCesLoad();
  if (_store) {
    if (path) {
      _store.setPath(path);
    } else {
      _store = undefined;
    }
  }
}

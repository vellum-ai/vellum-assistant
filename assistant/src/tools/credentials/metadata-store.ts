/**
 * Credential metadata store.
 *
 * Persists non-secret metadata about credentials (policy, timestamps, IDs)
 * in a versioned JSON file under protected storage. Secret values remain
 * in the secure key backend only.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getDataDir } from '../../util/platform.js';
import { randomUUID } from 'node:crypto';

export interface CredentialMetadata {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  usageDescription?: string;
  expiresAt?: number;
  grantedScopes?: string[];
  accountInfo?: string;
  createdAt: number;
  updatedAt: number;
}

interface MetadataFile {
  version: 1;
  credentials: CredentialMetadata[];
}

let overridePath: string | null = null;

function getMetadataPath(): string {
  if (overridePath) return overridePath;
  return join(getDataDir(), 'credentials', 'metadata.json');
}

/**
 * Returned when the on-disk file has a version we don't understand.
 * Callers that mutate state must check for this to avoid overwriting
 * data written by a newer version of the app.
 */
interface UnknownVersionResult {
  readonly unknownVersion: true;
}

type LoadResult = MetadataFile | UnknownVersionResult;

function isUnknownVersion(r: LoadResult): r is UnknownVersionResult {
  return 'unknownVersion' in r;
}

function loadFile(): LoadResult {
  const path = getMetadataPath();
  if (!existsSync(path)) {
    return { version: 1, credentials: [] };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) {
      return { version: 1, credentials: [] };
    }
    if (typeof data.version === 'number' && data.version !== 1) {
      // Newer numeric version we don't understand — refuse to touch it
      return { unknownVersion: true };
    }
    return {
      version: 1,
      credentials: Array.isArray(data.credentials) ? data.credentials : [],
    };
  } catch {
    return { version: 1, credentials: [] };
  }
}

function saveFile(data: MetadataFile): void {
  const path = getMetadataPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

/**
 * Throws if the metadata file has an unrecognized version.
 * Call this before performing irreversible keychain operations
 * so the operation fails cleanly before any side effects.
 */
export function assertMetadataWritable(): void {
  const result = loadFile();
  if (isUnknownVersion(result)) {
    throw new Error('Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss');
  }
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
    /** Pass `null` to explicitly clear a previously-set expiry. */
    expiresAt?: number | null;
    grantedScopes?: string[];
    accountInfo?: string;
  },
): CredentialMetadata {
  const result = loadFile();
  if (isUnknownVersion(result)) {
    throw new Error('Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss');
  }
  const data = result;
  const now = Date.now();

  const existing = data.credentials.find(
    (c) => c.service === service && c.field === field,
  );

  if (existing) {
    if (policy?.allowedTools !== undefined) existing.allowedTools = policy.allowedTools;
    if (policy?.allowedDomains !== undefined) existing.allowedDomains = policy.allowedDomains;
    if (policy?.usageDescription !== undefined) existing.usageDescription = policy.usageDescription;
    if (policy?.expiresAt !== undefined) {
      if (policy.expiresAt === null) {
        delete existing.expiresAt;
      } else {
        existing.expiresAt = policy.expiresAt;
      }
    }
    if (policy?.grantedScopes !== undefined) existing.grantedScopes = policy.grantedScopes;
    if (policy?.accountInfo !== undefined) existing.accountInfo = policy.accountInfo;
    existing.updatedAt = now;
    saveFile(data);
    return existing;
  }

  const record: CredentialMetadata = {
    credentialId: randomUUID(),
    service,
    field,
    allowedTools: policy?.allowedTools ?? [],
    allowedDomains: policy?.allowedDomains ?? [],
    usageDescription: policy?.usageDescription,
    expiresAt: policy?.expiresAt ?? undefined,
    grantedScopes: policy?.grantedScopes,
    accountInfo: policy?.accountInfo,
    createdAt: now,
    updatedAt: now,
  };

  data.credentials.push(record);
  saveFile(data);
  return record;
}

/**
 * Get metadata for a credential by service and field.
 */
export function getCredentialMetadata(
  service: string,
  field: string,
): CredentialMetadata | undefined {
  const result = loadFile();
  if (isUnknownVersion(result)) return undefined;
  return result.credentials.find(
    (c) => c.service === service && c.field === field,
  );
}

/**
 * Get metadata for a credential by its opaque ID.
 */
export function getCredentialMetadataById(
  credentialId: string,
): CredentialMetadata | undefined {
  const result = loadFile();
  if (isUnknownVersion(result)) return undefined;
  return result.credentials.find((c) => c.credentialId === credentialId);
}

/**
 * List all credential metadata records.
 */
export function listCredentialMetadata(): CredentialMetadata[] {
  const result = loadFile();
  if (isUnknownVersion(result)) return [];
  return result.credentials;
}

/**
 * Delete metadata for a credential.
 */
export function deleteCredentialMetadata(
  service: string,
  field: string,
): boolean {
  const result = loadFile();
  if (isUnknownVersion(result)) {
    throw new Error('Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss');
  }
  const data = result;
  const idx = data.credentials.findIndex(
    (c) => c.service === service && c.field === field,
  );
  if (idx === -1) return false;
  data.credentials.splice(idx, 1);
  saveFile(data);
  return true;
}

/** @internal Test-only: override the metadata file path. */
export function _setMetadataPath(path: string | null): void {
  overridePath = path;
}

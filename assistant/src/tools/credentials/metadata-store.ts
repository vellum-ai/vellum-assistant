/**
 * Credential metadata store.
 *
 * Persists non-secret metadata about credentials (policy, timestamps, IDs)
 * in a versioned JSON file under protected storage. Secret values remain
 * in the secure key backend only.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

function loadFile(): MetadataFile {
  const path = getMetadataPath();
  if (!existsSync(path)) {
    return { version: 1, credentials: [] };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as MetadataFile;
    if (data.version !== 1) {
      return { version: 1, credentials: [] };
    }
    return data;
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
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
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
  },
): CredentialMetadata {
  const data = loadFile();
  const now = Date.now();

  const existing = data.credentials.find(
    (c) => c.service === service && c.field === field,
  );

  if (existing) {
    if (policy?.allowedTools !== undefined) existing.allowedTools = policy.allowedTools;
    if (policy?.allowedDomains !== undefined) existing.allowedDomains = policy.allowedDomains;
    if (policy?.usageDescription !== undefined) existing.usageDescription = policy.usageDescription;
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
  const data = loadFile();
  return data.credentials.find(
    (c) => c.service === service && c.field === field,
  );
}

/**
 * Get metadata for a credential by its opaque ID.
 */
export function getCredentialMetadataById(
  credentialId: string,
): CredentialMetadata | undefined {
  const data = loadFile();
  return data.credentials.find((c) => c.credentialId === credentialId);
}

/**
 * List all credential metadata records.
 */
export function listCredentialMetadata(): CredentialMetadata[] {
  const data = loadFile();
  return data.credentials;
}

/**
 * Delete metadata for a credential.
 */
export function deleteCredentialMetadata(
  service: string,
  field: string,
): boolean {
  const data = loadFile();
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

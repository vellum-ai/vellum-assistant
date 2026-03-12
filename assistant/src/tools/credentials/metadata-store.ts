/**
 * Credential metadata store.
 *
 * Persists non-secret metadata about credentials (policy, timestamps, IDs)
 * in a versioned JSON file under protected storage. Secret values remain
 * in the secure key backend only.
 *
 * OAuth-specific fields (expiresAt, grantedScopes, oauth2TokenUrl,
 * oauth2ClientId, oauth2TokenEndpointAuthMethod, hasRefreshToken) are now
 * exclusively managed by the SQLite oauth-store and have been removed
 * from this interface as of v5.
 */

import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureDir, readTextFileSync } from "../../util/fs.js";
import { getDataDir } from "../../util/platform.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";

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

/** Current on-disk schema version. */
const CURRENT_VERSION = 5;

interface MetadataFile {
  version: typeof CURRENT_VERSION;
  credentials: CredentialMetadata[];
}

let overridePath: string | null = null;

function getMetadataPath(): string {
  if (overridePath) return overridePath;
  return join(getDataDir(), "credentials", "metadata.json");
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
  return "unknownVersion" in r;
}

/**
 * Returns true if a value looks like a valid credential record (has required fields).
 * Filters out corrupted or incomplete entries during migration.
 */
function isValidCredentialRecord(
  record: unknown,
): record is Record<string, unknown> {
  if (typeof record !== "object" || record == null) return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.credentialId === "string" &&
    typeof r.service === "string" &&
    typeof r.field === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number"
  );
}

/**
 * Migrate any record to v5 by stripping OAuth-specific fields that are
 * now exclusively managed by the SQLite oauth-store.
 */
function migrateRecordToV5(
  record: Record<string, unknown>,
): CredentialMetadata {
  return {
    credentialId: record.credentialId as string,
    service: record.service as string,
    field: record.field as string,
    allowedTools: Array.isArray(record.allowedTools)
      ? (record.allowedTools as string[])
      : [],
    allowedDomains: Array.isArray(record.allowedDomains)
      ? (record.allowedDomains as string[])
      : [],
    usageDescription:
      typeof record.usageDescription === "string"
        ? record.usageDescription
        : undefined,
    alias: typeof record.alias === "string" ? record.alias : undefined,
    injectionTemplates: Array.isArray(record.injectionTemplates)
      ? (record.injectionTemplates as CredentialInjectionTemplate[])
      : undefined,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  };
}

function loadFile(): LoadResult {
  const raw = readTextFileSync(getMetadataPath());
  if (raw == null) {
    return { version: CURRENT_VERSION, credentials: [] };
  }
  try {
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data == null) {
      return { version: CURRENT_VERSION, credentials: [] };
    }
    const fileVersion = typeof data.version === "number" ? data.version : 1;
    if (
      fileVersion !== 1 &&
      fileVersion !== 2 &&
      fileVersion !== 3 &&
      fileVersion !== 4 &&
      fileVersion !== 5
    ) {
      // Unrecognized version (future, fractional, negative, zero) — refuse to touch it
      return { unknownVersion: true };
    }
    const rawCredentials: unknown[] = Array.isArray(data.credentials)
      ? data.credentials
      : [];
    // Filter out malformed entries that lack required fields
    const validRecords = rawCredentials.filter(isValidCredentialRecord);

    if (fileVersion < CURRENT_VERSION) {
      // Migrate all older versions to v5 by stripping OAuth-specific fields
      // and removing ghost refresh_token records
      const filtered = validRecords.filter(
        (r) => (r as Record<string, unknown>).field !== "refresh_token",
      );
      const credentials = filtered.map(migrateRecordToV5);
      const migrated: MetadataFile = { version: CURRENT_VERSION, credentials };
      try {
        saveFile(migrated);
      } catch {
        /* persist failed — will retry on next write */
      }
      return migrated;
    }

    return {
      version: CURRENT_VERSION,
      credentials: validRecords as unknown as CredentialMetadata[],
    };
  } catch {
    // Corrupted / unparseable file — treat as empty to avoid data loss on next write
    return { version: CURRENT_VERSION, credentials: [] };
  }
}

function saveFile(data: MetadataFile): void {
  const path = getMetadataPath();
  const dir = dirname(path);
  ensureDir(dir);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
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
    throw new Error(
      "Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss",
    );
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
    /** Pass `null` to explicitly clear a previously-set alias. */
    alias?: string | null;
    /** Pass `null` to explicitly clear injection templates. */
    injectionTemplates?: CredentialInjectionTemplate[] | null;
  },
): CredentialMetadata {
  const result = loadFile();
  if (isUnknownVersion(result)) {
    throw new Error(
      "Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss",
    );
  }
  const data = result;
  const now = Date.now();

  const existing = data.credentials.find(
    (c) => c.service === service && c.field === field,
  );

  if (existing) {
    if (policy?.allowedTools !== undefined)
      existing.allowedTools = policy.allowedTools;
    if (policy?.allowedDomains !== undefined)
      existing.allowedDomains = policy.allowedDomains;
    if (policy?.usageDescription !== undefined)
      existing.usageDescription = policy.usageDescription;
    if (policy?.alias !== undefined) {
      if (policy.alias == null) {
        delete existing.alias;
      } else {
        existing.alias = policy.alias;
      }
    }
    if (policy?.injectionTemplates !== undefined) {
      if (policy.injectionTemplates == null) {
        delete existing.injectionTemplates;
      } else {
        existing.injectionTemplates = policy.injectionTemplates;
      }
    }
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
    alias: policy?.alias ?? undefined,
    injectionTemplates: policy?.injectionTemplates ?? undefined,
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
    throw new Error(
      "Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss",
    );
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

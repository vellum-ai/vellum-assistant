/**
 * Credential metadata store.
 *
 * Persists non-secret metadata about credentials (policy, timestamps, IDs)
 * in a versioned JSON file under protected storage. Secret values remain
 * in the secure key backend only.
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
  expiresAt?: number;
  grantedScopes?: string[];
  /** OAuth2 token endpoint — enables autonomous token refresh without an IntegrationDefinition. */
  oauth2TokenUrl?: string;
  /** OAuth2 client ID — paired with oauth2TokenUrl for refresh. */
  oauth2ClientId?: string;
  /** How the client authenticates at the token endpoint (client_secret_basic or client_secret_post). */
  oauth2TokenEndpointAuthMethod?: string;
  /** Human-friendly name for this credential (e.g. "fal-primary"). */
  alias?: string;
  /** Templates describing how to inject this credential into proxied requests. */
  injectionTemplates?: CredentialInjectionTemplate[];
  createdAt: number;
  updatedAt: number;
}

/** Current on-disk schema version. */
const CURRENT_VERSION = 3;

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
 * Migrate a v1 record to v2 by backfilling new optional fields with defaults.
 */
function migrateRecordV1toV2(
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
    expiresAt:
      typeof record.expiresAt === "number" ? record.expiresAt : undefined,
    grantedScopes: Array.isArray(record.grantedScopes)
      ? (record.grantedScopes as string[])
      : undefined,
    oauth2TokenUrl:
      typeof record.oauth2TokenUrl === "string"
        ? record.oauth2TokenUrl
        : undefined,
    oauth2ClientId:
      typeof record.oauth2ClientId === "string"
        ? record.oauth2ClientId
        : undefined,
    oauth2TokenEndpointAuthMethod:
      typeof record.oauth2TokenEndpointAuthMethod === "string"
        ? record.oauth2TokenEndpointAuthMethod
        : undefined,
    alias: typeof record.alias === "string" ? record.alias : undefined,
    injectionTemplates: Array.isArray(record.injectionTemplates)
      ? (record.injectionTemplates as CredentialInjectionTemplate[])
      : undefined,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  };
}

/**
 * Migrate a v2 record to v3 by stripping the oauth2ClientSecret field.
 * Client secrets are now read exclusively from the secure key store.
 */
function migrateRecordV2toV3(record: CredentialMetadata): CredentialMetadata {
  const { oauth2ClientSecret: _removed, ...rest } =
    record as CredentialMetadata & { oauth2ClientSecret?: string };
  return rest;
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
    if (fileVersion !== 1 && fileVersion !== 2 && fileVersion !== 3) {
      // Unrecognized version (future, fractional, negative, zero) — refuse to touch it
      return { unknownVersion: true };
    }
    const rawCredentials: unknown[] = Array.isArray(data.credentials)
      ? data.credentials
      : [];
    // Filter out malformed entries that lack required fields
    const validRecords = rawCredentials.filter(isValidCredentialRecord);

    if (fileVersion < CURRENT_VERSION) {
      // Apply migrations in sequence: v1→v2→v3
      let credentials: CredentialMetadata[];
      if (fileVersion === 1) {
        credentials = validRecords
          .map(migrateRecordV1toV2)
          .map(migrateRecordV2toV3);
      } else {
        // fileVersion === 2
        credentials = (validRecords as unknown as CredentialMetadata[]).map(
          migrateRecordV2toV3,
        );
      }
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
    /** Pass `null` to explicitly clear a previously-set expiry. */
    expiresAt?: number | null;
    grantedScopes?: string[];
    oauth2TokenUrl?: string;
    oauth2ClientId?: string;
    oauth2TokenEndpointAuthMethod?: string;
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
    if (policy?.expiresAt !== undefined) {
      if (policy.expiresAt == null) {
        delete existing.expiresAt;
      } else {
        existing.expiresAt = policy.expiresAt;
      }
    }
    if (policy?.grantedScopes !== undefined)
      existing.grantedScopes = policy.grantedScopes;
    if (policy?.oauth2TokenUrl !== undefined)
      existing.oauth2TokenUrl = policy.oauth2TokenUrl;
    if (policy?.oauth2ClientId !== undefined)
      existing.oauth2ClientId = policy.oauth2ClientId;
    if (policy?.oauth2TokenEndpointAuthMethod !== undefined)
      existing.oauth2TokenEndpointAuthMethod =
        policy.oauth2TokenEndpointAuthMethod;
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
    expiresAt: policy?.expiresAt ?? undefined,
    grantedScopes: policy?.grantedScopes,
    oauth2TokenUrl: policy?.oauth2TokenUrl,
    oauth2ClientId: policy?.oauth2ClientId,
    oauth2TokenEndpointAuthMethod: policy?.oauth2TokenEndpointAuthMethod,
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

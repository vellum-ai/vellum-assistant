/**
 * Static credential metadata persistence primitives.
 *
 * Provides a portable, path-parameterized metadata store for local static
 * credential records. This module has NO dependency on the assistant daemon,
 * platform helpers, or any service-specific code — callers supply the file
 * path and this module handles versioned JSON persistence with atomic writes.
 *
 * The assistant's `metadata-store.ts` wires in the platform-specific data
 * directory and re-exports convenience functions that delegate here.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { InjectionTemplate, StaticCredentialRecord } from "./index.js";

// ---------------------------------------------------------------------------
// On-disk schema
// ---------------------------------------------------------------------------

/** Current on-disk schema version. */
const CURRENT_VERSION = 5;

interface MetadataFile {
  version: typeof CURRENT_VERSION;
  credentials: StaticCredentialRecord[];
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

// ---------------------------------------------------------------------------
// Validation & migration helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a value looks like a valid credential record (has required fields).
 * Filters out corrupted or incomplete entries during migration.
 */
function isValidCredentialRecord(
  record: unknown
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
  record: Record<string, unknown>
): StaticCredentialRecord {
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
      ? (record.injectionTemplates as InjectionTemplate[])
      : undefined,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers (inlined to avoid assistant-specific imports)
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readTextFileSync(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core store implementation
// ---------------------------------------------------------------------------

function loadFile(
  metadataPath: string,
  saveFileFn: (data: MetadataFile, path: string) => void
): LoadResult {
  const raw = readTextFileSync(metadataPath);
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
        (r) => (r as Record<string, unknown>).field !== "refresh_token"
      );
      const credentials = filtered.map(migrateRecordToV5);
      const migrated: MetadataFile = { version: CURRENT_VERSION, credentials };
      try {
        saveFileFn(migrated, metadataPath);
      } catch {
        /* persist failed — will retry on next write */
      }
      return migrated;
    }

    return {
      version: CURRENT_VERSION,
      credentials: (validRecords as unknown) as StaticCredentialRecord[],
    };
  } catch {
    // Corrupted / unparseable file — treat as empty to avoid data loss on next write
    return { version: CURRENT_VERSION, credentials: [] };
  }
}

function saveFile(data: MetadataFile, path: string): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Policy input for upsert
// ---------------------------------------------------------------------------

/** Policy fields that can be set or updated when upserting a credential. */
export interface StaticCredentialPolicyInput {
  allowedTools?: string[];
  allowedDomains?: string[];
  usageDescription?: string;
  /** Pass `null` to explicitly clear a previously-set alias. */
  alias?: string | null;
  /** Pass `null` to explicitly clear injection templates. */
  injectionTemplates?: InjectionTemplate[] | null;
}

// ---------------------------------------------------------------------------
// StaticCredentialMetadataStore
// ---------------------------------------------------------------------------

/**
 * Portable, path-parameterized metadata store for local static credentials.
 *
 * Callers supply the file path; this class handles versioned JSON persistence,
 * schema migration, and CRUD operations. It has no dependency on the assistant
 * daemon or platform-specific code.
 */
export class StaticCredentialMetadataStore {
  private metadataPath: string;

  constructor(metadataPath: string) {
    this.metadataPath = metadataPath;
  }

  /** Update the metadata file path (primarily for testing). */
  setPath(path: string): void {
    this.metadataPath = path;
  }

  /** Get the current metadata file path. */
  getPath(): string {
    return this.metadataPath;
  }

  /**
   * Throws if the metadata file has an unrecognized version.
   * Call this before performing irreversible credential store operations
   * so the operation fails cleanly before any side effects.
   */
  assertWritable(): void {
    const result = loadFile(this.metadataPath, saveFile);
    if (isUnknownVersion(result)) {
      throw new Error(
        "Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss"
      );
    }
  }

  /**
   * Create or update a credential metadata record.
   * If a record with the same service+field exists, it is updated.
   */
  upsert(
    service: string,
    field: string,
    policy?: StaticCredentialPolicyInput
  ): StaticCredentialRecord {
    const result = loadFile(this.metadataPath, saveFile);
    if (isUnknownVersion(result)) {
      throw new Error(
        "Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss"
      );
    }
    const data = result;
    const now = Date.now();

    const existing = data.credentials.find(
      (c) => c.service === service && c.field === field
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
      saveFile(data, this.metadataPath);
      return existing;
    }

    const record: StaticCredentialRecord = {
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
    saveFile(data, this.metadataPath);
    return record;
  }

  /**
   * Get metadata for a credential by service and field.
   */
  getByServiceField(
    service: string,
    field: string
  ): StaticCredentialRecord | undefined {
    const result = loadFile(this.metadataPath, saveFile);
    if (isUnknownVersion(result)) return undefined;
    return result.credentials.find(
      (c) => c.service === service && c.field === field
    );
  }

  /**
   * Get metadata for a credential by its opaque ID.
   */
  getById(credentialId: string): StaticCredentialRecord | undefined {
    const result = loadFile(this.metadataPath, saveFile);
    if (isUnknownVersion(result)) return undefined;
    return result.credentials.find((c) => c.credentialId === credentialId);
  }

  /**
   * List all credential metadata records.
   */
  list(): StaticCredentialRecord[] {
    const result = loadFile(this.metadataPath, saveFile);
    if (isUnknownVersion(result)) return [];
    return result.credentials;
  }

  /**
   * Delete metadata for a credential.
   */
  delete(service: string, field: string): boolean {
    const result = loadFile(this.metadataPath, saveFile);
    if (isUnknownVersion(result)) {
      throw new Error(
        "Credential metadata file has an unrecognized version; refusing to mutate to avoid data loss"
      );
    }
    const data = result;
    const idx = data.credentials.findIndex(
      (c) => c.service === service && c.field === field
    );
    if (idx === -1) return false;
    data.credentials.splice(idx, 1);
    saveFile(data, this.metadataPath);
    return true;
  }
}

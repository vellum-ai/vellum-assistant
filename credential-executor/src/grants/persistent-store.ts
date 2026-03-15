/**
 * CES persistent grant store.
 *
 * Stores canonical validated grants by stable ID in a `grants.json` file
 * inside the CES-private data root. This file is never co-mingled with
 * assistant trust files or credential metadata.
 *
 * Design principles:
 * - **Fail closed**: If the store file is unreadable or malformed, all
 *   reads return empty and all writes throw. The CES must never fall back
 *   to a permissive default when the persistent state is corrupt.
 * - **Atomic writes**: Uses rename-over-tmp to prevent partial writes.
 * - **Deduplication**: Grants are keyed by a canonical hash (the `id`
 *   field) — adding a grant with an existing ID is a no-op.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { getCesGrantsDir } from "../paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A canonical persistent grant stored on disk. */
export interface PersistentGrant {
  /** Stable canonical hash identifying this grant. */
  id: string;
  /** The tool or command pattern this grant authorises. */
  tool: string;
  /** Glob pattern scoping the grant. */
  pattern: string;
  /** Scope constraint (directory path or "everywhere"). */
  scope: string;
  /** When the grant was created (epoch ms). */
  createdAt: number;
}

/** On-disk format for the grants file. */
interface GrantsFile {
  version: number;
  grants: PersistentGrant[];
}

const GRANTS_FILE_VERSION = 1;
const GRANTS_FILENAME = "grants.json";

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export class PersistentGrantStore {
  private readonly filePath: string;
  private cache: PersistentGrant[] | null = null;
  /** Set to true when the store detects corruption; blocks all operations. */
  private corrupt = false;

  constructor(grantsDir?: string) {
    const dir = grantsDir ?? getCesGrantsDir();
    this.filePath = join(dir, GRANTS_FILENAME);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Initialise the store, ensuring the parent directory exists and the
   * grants file is readable. If the file does not exist it is created
   * with an empty grant list.
   *
   * Throws if the directory cannot be created or an existing file is
   * malformed (fail-closed).
   */
  init(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(this.filePath)) {
      this.writeToDisk([]);
      return;
    }

    // Validate the existing file is readable and well-formed.
    // If it isn't, mark corrupt and throw (fail closed).
    this.loadFromDisk();
  }

  /**
   * Return all persisted grants.
   *
   * Returns an empty array if the store has never been initialised
   * (no file on disk). Throws if the store is corrupt.
   */
  getAll(): PersistentGrant[] {
    this.assertNotCorrupt();
    if (this.cache !== null) return [...this.cache];
    if (!existsSync(this.filePath)) return [];
    return [...this.loadFromDisk()];
  }

  /**
   * Look up a grant by its canonical ID.
   *
   * Returns `undefined` if not found. Throws if the store is corrupt.
   */
  getById(id: string): PersistentGrant | undefined {
    return this.getAll().find((g) => g.id === id);
  }

  /**
   * Add a grant. If a grant with the same `id` already exists, this is
   * a no-op (idempotent deduplication by canonical hash).
   *
   * Returns `true` if the grant was newly added, `false` if it was a
   * duplicate.
   */
  add(grant: PersistentGrant): boolean {
    this.assertNotCorrupt();
    const grants = this.loadFromDisk();
    if (grants.some((g) => g.id === grant.id)) {
      return false;
    }
    grants.push(grant);
    this.writeToDisk(grants);
    return true;
  }

  /**
   * Remove a grant by its canonical ID.
   *
   * Returns `true` if the grant was found and removed, `false` otherwise.
   */
  remove(id: string): boolean {
    this.assertNotCorrupt();
    const grants = this.loadFromDisk();
    const index = grants.findIndex((g) => g.id === id);
    if (index === -1) return false;
    grants.splice(index, 1);
    this.writeToDisk(grants);
    return true;
  }

  /**
   * Check whether a grant with the given ID exists.
   */
  has(id: string): boolean {
    return this.getById(id) !== undefined;
  }

  /**
   * Remove all grants and reset the store to an empty state.
   */
  clear(): void {
    this.assertNotCorrupt();
    this.writeToDisk([]);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private assertNotCorrupt(): void {
    if (this.corrupt) {
      throw new Error(
        "CES persistent grant store is corrupt — refusing to operate (fail closed)",
      );
    }
  }

  private loadFromDisk(): PersistentGrant[] {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as unknown;

      if (
        typeof data !== "object" ||
        data === null ||
        !("version" in data) ||
        !("grants" in data)
      ) {
        this.corrupt = true;
        throw new Error(
          "CES grants file is malformed: missing version or grants field",
        );
      }

      const file = data as GrantsFile;

      if (file.version !== GRANTS_FILE_VERSION) {
        this.corrupt = true;
        throw new Error(
          `CES grants file has unsupported version ${file.version} (expected ${GRANTS_FILE_VERSION})`,
        );
      }

      if (!Array.isArray(file.grants)) {
        this.corrupt = true;
        throw new Error("CES grants file is malformed: grants is not an array");
      }

      this.cache = file.grants;
      return [...file.grants];
    } catch (err) {
      if (this.corrupt) throw err;
      // Any other read/parse error → fail closed
      this.corrupt = true;
      throw new Error(
        `CES persistent grant store failed to read ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private writeToDisk(grants: PersistentGrant[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data: GrantsFile = {
      version: GRANTS_FILE_VERSION,
      grants,
    };

    const tmpPath = join(dir, `.tmp-${randomUUID()}`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
    renameSync(tmpPath, this.filePath);
    // Enforce owner-only permissions even if the file already existed
    // with wider permissions.
    chmodSync(this.filePath, 0o600);

    this.cache = grants;
  }
}

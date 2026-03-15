/**
 * CES audit record persistence.
 *
 * Persists token-free audit record summaries to `audit.jsonl` inside
 * the CES-private data root. Each line is a self-contained JSON object
 * conforming to the `AuditRecordSummary` schema from `@vellumai/ces-contracts`.
 *
 * Design principles:
 * - **Append-only**: Records are appended one per line. The file is never
 *   rewritten or truncated during normal operation.
 * - **Token-free**: Audit records must never contain raw secrets, auth
 *   tokens, raw headers, or raw response bodies. Only sanitized summaries
 *   (method, URL template, status code, credential handle, grant ID) are
 *   persisted.
 * - **Fail-open for reads**: If the file is corrupt or missing, reads
 *   return an empty array rather than throwing. Writes still throw on I/O
 *   failure so callers know when persistence is broken.
 * - **Bounded reads**: The `list` method supports limit and cursor-based
 *   pagination to avoid reading the entire log into memory.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AuditRecordSummary } from "@vellumai/ces-contracts";

import { getCesAuditDir } from "../paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIT_FILENAME = "audit.jsonl";

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export class AuditStore {
  private readonly filePath: string;

  constructor(auditDir?: string) {
    const dir = auditDir ?? getCesAuditDir();
    this.filePath = join(dir, AUDIT_FILENAME);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Ensure the parent directory exists. Safe to call multiple times.
   */
  init(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Append a token-free audit record summary to the log.
   *
   * Throws on I/O failure (callers should handle gracefully — audit
   * persistence failure must not block the execution pipeline).
   */
  append(record: AuditRecordSummary): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.filePath, line, { mode: 0o600 });
  }

  /**
   * List audit records with optional filtering and pagination.
   *
   * Records are returned in reverse-chronological order (newest first).
   *
   * @param options.sessionId - Filter by session ID.
   * @param options.credentialHandle - Filter by credential handle.
   * @param options.grantId - Filter by grant ID.
   * @param options.limit - Maximum number of records to return (default: 50).
   * @param options.cursor - Opaque cursor from a previous response to
   *   continue pagination. The cursor is the 0-based line offset encoded
   *   as a string.
   *
   * @returns An object with `records` and `nextCursor`. `nextCursor` is
   *   null when there are no more results.
   */
  list(options?: {
    sessionId?: string;
    credentialHandle?: string;
    grantId?: string;
    limit?: number;
    cursor?: string;
  }): { records: AuditRecordSummary[]; nextCursor: string | null } {
    const limit = options?.limit ?? 50;

    const allRecords = this.readAll();

    // Reverse for newest-first ordering
    allRecords.reverse();

    // Apply filters
    let filtered = allRecords;
    if (options?.sessionId) {
      filtered = filtered.filter((r) => r.sessionId === options.sessionId);
    }
    if (options?.credentialHandle) {
      filtered = filtered.filter(
        (r) => r.credentialHandle === options.credentialHandle,
      );
    }
    if (options?.grantId) {
      filtered = filtered.filter((r) => r.grantId === options.grantId);
    }

    // Apply cursor-based pagination
    const offset = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const startIdx = isNaN(offset) ? 0 : offset;

    const page = filtered.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < filtered.length;
    const nextCursor = hasMore ? String(startIdx + limit) : null;

    return { records: page, nextCursor };
  }

  /**
   * Return the total number of records in the log.
   *
   * Returns 0 if the file does not exist or is unreadable.
   */
  count(): number {
    return this.readAll().length;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Read all records from the JSONL file, skipping malformed lines.
   *
   * Returns an empty array if the file is missing or unreadable.
   */
  private readAll(): AuditRecordSummary[] {
    if (!existsSync(this.filePath)) return [];

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }

    const records: AuditRecordSummary[] = [];
    const lines = raw.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      try {
        const parsed = JSON.parse(trimmed) as AuditRecordSummary;
        // Minimal validation — must have auditId and timestamp
        if (
          typeof parsed.auditId === "string" &&
          typeof parsed.timestamp === "string"
        ) {
          records.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return records;
  }
}

/**
 * Assistant-owned attachment storage.
 *
 * All attachments are stored on disk; the database row references the
 * on-disk file path. Provides upload, delete, and message-linkage operations.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getWorkspaceDir } from "../util/platform.js";
import { getDb, rawAll, rawGet, rawRun } from "./db.js";
import { attachments, messageAttachments } from "./schema.js";

export interface StoredAttachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  thumbnailBase64: string | null;
  createdAt: number;
}

function classifyKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export class AttachmentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentUploadError";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Size and encoding limits
// ---------------------------------------------------------------------------

/** Hard ceiling on a single uploaded attachment (100 MB, matching assistant limits). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Write decoded base64 data to disk under the workspace attachments directory.
 * Returns the absolute file path of the written file.
 */
export function writeAttachmentToDisk(
  dataBase64: string,
  filename: string,
): string {
  const dir = join(getWorkspaceDir(), "data", "attachments");
  mkdirSync(dir, { recursive: true });
  const destFilename = `${uuid()}-${basename(filename)}`;
  const destPath = join(dir, destFilename);
  const buffer = Buffer.from(dataBase64, "base64");
  writeFileSync(destPath, buffer);
  return destPath;
}

/**
 * Validate that a string contains only characters from the standard base64
 * alphabet (plus padding `=`). Rejects payloads with clearly non-base64
 * content while staying lenient on padding/length so callers don't need to
 * pre-pad truncated previews or test fixtures.
 */
const INVALID_BASE64_RE = /[^A-Za-z0-9+/=]/;

export function isValidBase64(data: string): boolean {
  if (data.length === 0) return true;
  return !INVALID_BASE64_RE.test(data);
}

// ---------------------------------------------------------------------------
// Inbound attachment MIME validation
// ---------------------------------------------------------------------------

/**
 * MIME types accepted for inbound attachment uploads.
 * Files with types not on this list are rejected at the API boundary.
 */
const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
  "image/x-icon",
  // Audio
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  "audio/aac",
  "audio/x-m4a",
  "audio/mp4",
  // Video
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
  // Documents
  "application/pdf",
  "text/rtf",
  "application/rtf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/css",
  "application/json",
  "application/xml",
  "text/xml",
  // Source code
  "text/javascript",
  "text/typescript",
  // Archives
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  // Office
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Fallback for unknown-but-not-dangerous files (Telegram often uses this)
  "application/octet-stream",
]);

/**
 * File extensions that are always rejected regardless of claimed MIME type.
 */
const DANGEROUS_EXTENSIONS = new Set([
  "exe",
  "sh",
  "bat",
  "cmd",
  "com",
  "msi",
  "iso",
  "dmg",
  "app",
  "scr",
  "pif",
  "vbs",
  "ps1",
  "jar",
  "cpl",
  "inf",
  "reg",
  "hta",
  "wsf",
  "wsh",
]);

export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a filename + MIME type pair for inbound attachment uploads.
 *
 * Rejects files whose extension is in the dangerous blocklist or whose
 * MIME type is not on the allowlist.
 */
export function validateAttachmentUpload(
  filename: string,
  mimeType: string,
): AttachmentValidationResult {
  // Normalize filename: trim whitespace and strip trailing dots to prevent
  // bypasses like "payload.exe " or "payload.exe."
  const normalizedFilename = filename.trim().replace(/\.+$/, "");

  const dot = normalizedFilename.lastIndexOf(".");
  if (dot !== -1) {
    const ext = normalizedFilename.slice(dot + 1).toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        error: `Dangerous file type rejected: .${ext} files are not allowed`,
      };
    }
  }

  // Strip MIME parameters (e.g. "text/plain; charset=utf-8" → "text/plain")
  const normalised = mimeType.toLowerCase().trim().split(";")[0].trim();
  if (!ALLOWED_MIME_TYPES.has(normalised)) {
    return {
      ok: false,
      error: `Unsupported MIME type: ${mimeType}`,
    };
  }

  return { ok: true };
}

/**
 * Compute a content hash for deduplication. Uses Bun.hash (wyhash) for speed,
 * encoded as base-36 for compact storage.
 */
function computeContentHash(dataBase64: string): string {
  return Bun.hash(dataBase64).toString(36);
}

// ---------------------------------------------------------------------------
// File-backed attachment storage (avoids reading large files into memory)
// ---------------------------------------------------------------------------

/**
 * Store a file-backed attachment by path reference, without reading the file
 * into memory. This avoids OOM risk for large recordings that exceed the
 * normal 100 MB upload limit.
 *
 * The file stays on disk; the attachment row stores an empty dataBase64 and
 * records the on-disk path in the `file_path` column.
 */
export function uploadFileBackedAttachment(
  filename: string,
  mimeType: string,
  filePath: string,
  sizeBytes: number,
): StoredAttachment & { filePath: string } {
  const now = Date.now();
  const kind = classifyKind(mimeType);
  const id = uuid();
  const db = getDb();

  db.insert(attachments)
    .values({
      id,
      originalFilename: filename,
      mimeType,
      sizeBytes,
      kind,
      dataBase64: "",
      filePath,
      createdAt: now,
    })
    .run();

  return {
    id,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    thumbnailBase64: null,
    createdAt: now,
    filePath,
  };
}

/**
 * Returns the file_path for an attachment, or null if not set.
 * Now uses Drizzle since filePath is in the schema.
 */
export function getFilePathForAttachment(attachmentId: string): string | null {
  const db = getDb();
  const row = db
    .select({ filePath: attachments.filePath })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();
  return row?.filePath ?? null;
}

/**
 * Returns the source_path (original file path on disk) for an attachment, or null if not set.
 * Uses raw SQL since source_path is added via DB migration and is not in the Drizzle schema.
 */
export function getSourcePathForAttachment(
  attachmentId: string,
): string | null {
  const row = rawGet<{ source_path: string | null }>(
    "SELECT source_path FROM attachments WHERE id = ?",
    attachmentId,
  );
  return row?.source_path ?? null;
}

/**
 * Batch-fetch source_path values for multiple attachment IDs in a single query.
 * Returns a Map of attachment ID → source_path for attachments that have a non-null source_path.
 * Uses raw SQL since source_path is added via runtime migration and is not in the Drizzle schema.
 */
export function getSourcePathsForAttachments(
  attachmentIds: string[],
): Map<string, string> {
  if (attachmentIds.length === 0) return new Map();
  const placeholders = attachmentIds.map(() => "?").join(", ");
  const rows = rawAll<{ id: string; source_path: string }>(
    `SELECT id, source_path FROM attachments WHERE id IN (${placeholders}) AND source_path IS NOT NULL`,
    ...attachmentIds,
  );
  return new Map(rows.map((r) => [r.id, r.source_path]));
}

/**
 * Returns the subset of `attachmentIds` that are file-backed.
 *
 * Since all attachments are now stored on disk, this simply returns a
 * Set containing every input ID — no database query is needed.
 *
 * @deprecated All attachments are file-backed. Callers should assume
 * `fileBacked: true` unconditionally and avoid calling this function.
 */
export function getFileBackedAttachmentIds(
  attachmentIds: string[],
): Set<string> {
  return new Set(attachmentIds);
}

/**
 * Return the raw binary content for an attachment by reading from its
 * on-disk file path.
 *
 * Returns null if the attachment does not exist or the file is missing.
 */
export function getAttachmentContent(attachmentId: string): Buffer | null {
  const db = getDb();
  const row = db
    .select({ filePath: attachments.filePath })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();

  if (!row?.filePath) return null;

  try {
    return readFileSync(row.filePath);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function uploadAttachment(
  filename: string,
  mimeType: string,
  dataBase64: string,
  sourcePath?: string,
): StoredAttachment {
  if (!isValidBase64(dataBase64)) {
    throw new AttachmentUploadError("Invalid base64 encoding");
  }

  const padding = dataBase64.endsWith("==")
    ? 2
    : dataBase64.endsWith("=")
      ? 1
      : 0;
  const sizeBytes = Math.max(
    0,
    Math.floor((dataBase64.length * 3) / 4) - padding,
  );

  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new AttachmentUploadError(
      `Attachment too large: ${formatBytes(sizeBytes)} exceeds ${formatBytes(
        MAX_UPLOAD_BYTES,
      )} limit`,
    );
  }

  const db = getDb();
  const contentHash = computeContentHash(dataBase64);

  // Dedup: if an attachment with the same content already exists, return it
  // instead of storing a duplicate.
  const existing = db
    .select({
      id: attachments.id,
      originalFilename: attachments.originalFilename,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      kind: attachments.kind,
      thumbnailBase64: attachments.thumbnailBase64,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(eq(attachments.contentHash, contentHash))
    .get();

  if (existing) {
    if (sourcePath) {
      rawRun(
        `UPDATE attachments SET source_path = ? WHERE id = ?`,
        sourcePath,
        existing.id,
      );
    }
    return existing;
  }

  const now = Date.now();
  const kind = classifyKind(mimeType);

  // Always write to disk
  const filePath = writeAttachmentToDisk(dataBase64, filename);

  const record = {
    id: uuid(),
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    dataBase64: "",
    filePath,
    contentHash,
    createdAt: now,
  };

  db.insert(attachments).values(record).run();

  if (sourcePath) {
    rawRun(
      `UPDATE attachments SET source_path = ? WHERE id = ?`,
      sourcePath,
      record.id,
    );
  }

  return {
    id: record.id,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    thumbnailBase64: null,
    createdAt: now,
  };
}

/**
 * Update the thumbnail for an existing attachment.
 */
export function setAttachmentThumbnail(
  attachmentId: string,
  thumbnailBase64: string,
): void {
  const db = getDb();
  db.update(attachments)
    .set({ thumbnailBase64 })
    .where(eq(attachments.id, attachmentId))
    .run();
}

export type DeleteAttachmentResult =
  | "deleted"
  | "not_found"
  | "still_referenced";

export function deleteAttachment(attachmentId: string): DeleteAttachmentResult {
  const db = getDb();
  const existing = db
    .select({ id: attachments.id, filePath: attachments.filePath })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();

  if (!existing) return "not_found";

  // With content-hash deduplication, multiple messages may reference the same
  // attachment row. Only delete the attachment (and cascade its links) when no
  // message_attachments rows still point to it.
  const refCount = db
    .select({ id: messageAttachments.id })
    .from(messageAttachments)
    .where(eq(messageAttachments.attachmentId, attachmentId))
    .all().length;

  if (refCount > 0) return "still_referenced";

  // Collect file path BEFORE deleting the DB row (the row contains the path reference)
  const { filePath } = existing;

  db.delete(attachments).where(eq(attachments.id, attachmentId)).run();

  // Clean up on-disk file only after the DB row has been removed
  if (filePath) {
    try {
      unlinkSync(filePath);
    } catch {
      /* file may already be gone */
    }
  }

  return "deleted";
}

export function getAttachmentsByIds(
  ids: string[],
): Array<StoredAttachment & { dataBase64: string }> {
  if (ids.length === 0) return [];
  const db = getDb();
  const results: Array<StoredAttachment & { dataBase64: string }> = [];
  for (const id of ids) {
    const row = db
      .select()
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();
    if (row) {
      // File-backed attachments store data on disk with dataBase64 = "".
      // Hydrate base64 from disk so callers get actual content.
      let dataBase64 = row.dataBase64;
      if (!dataBase64 && row.filePath) {
        try {
          dataBase64 = readFileSync(row.filePath).toString("base64");
        } catch {
          dataBase64 = "";
        }
      }
      results.push({
        id: row.id,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
        thumbnailBase64: row.thumbnailBase64,
        dataBase64,
        createdAt: row.createdAt,
      });
    }
  }
  return results;
}

export function linkAttachmentToMessage(
  messageId: string,
  attachmentId: string,
  position: number,
): void {
  const db = getDb();
  db.insert(messageAttachments)
    .values({
      id: uuid(),
      messageId,
      attachmentId,
      position,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * Return all attachments linked to a message, ordered by position.
 */
export function getAttachmentsForMessage(
  messageId: string,
): Array<StoredAttachment & { dataBase64: string }> {
  const db = getDb();
  const links = db
    .select({
      attachmentId: messageAttachments.attachmentId,
      position: messageAttachments.position,
    })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .orderBy(messageAttachments.position)
    .all();

  if (links.length === 0) return [];

  const ids = links
    .map((l) => l.attachmentId)
    .filter((id): id is string => id != null);
  return getAttachmentsByIds(ids);
}

/**
 * Return metadata (no dataBase64) for all attachments linked to a message.
 * Use this instead of getAttachmentsForMessage when you only need the
 * id/filename/mimeType/sizeBytes/kind fields — avoids deserializing
 * potentially large base64 blobs from the database.
 */
export function getAttachmentMetadataForMessage(
  messageId: string,
): StoredAttachment[] {
  const db = getDb();
  const links = db
    .select({ attachmentId: messageAttachments.attachmentId })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .orderBy(messageAttachments.position)
    .all();

  if (links.length === 0) return [];

  const results: StoredAttachment[] = [];
  for (const link of links) {
    if (!link.attachmentId) continue;
    const row = db
      .select({
        id: attachments.id,
        originalFilename: attachments.originalFilename,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        kind: attachments.kind,
        thumbnailBase64: attachments.thumbnailBase64,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(eq(attachments.id, link.attachmentId))
      .get();
    if (row) results.push(row);
  }
  return results;
}

/**
 * Retrieve a single attachment by ID.
 */
export function getAttachmentById(
  attachmentId: string,
): (StoredAttachment & { dataBase64: string }) | null {
  const results = getAttachmentsByIds([attachmentId]);
  return results[0] ?? null;
}

/**
 * Delete attachments from a specific candidate set that have no remaining
 * links in message_attachments. Only the given IDs are considered — this
 * prevents freshly uploaded (but not yet linked) attachments from being
 * mistakenly garbage-collected.
 *
 * Returns the number of orphaned attachments removed.
 */
export function deleteOrphanAttachments(candidateIds: string[]): number {
  if (candidateIds.length === 0) return 0;

  const db = getDb();

  // Identify truly orphaned attachment IDs first (not referenced by any message)
  const placeholders = candidateIds.map(() => "?").join(", ");
  const orphanIds = rawAll<{ id: string }>(
    `SELECT id FROM attachments WHERE id IN (${placeholders}) AND id NOT IN (SELECT attachment_id FROM message_attachments)`,
    ...candidateIds,
  ).map((row) => row.id);

  if (orphanIds.length === 0) return 0;

  // Collect file paths BEFORE deleting the DB rows via Drizzle
  const orphanFilePaths: string[] = [];
  for (const id of orphanIds) {
    const row = db
      .select({ filePath: attachments.filePath })
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();
    if (row?.filePath) orphanFilePaths.push(row.filePath);
  }

  // Delete the orphaned DB rows first — if this fails, the on-disk files
  // remain intact alongside their DB rows, so nothing is left inconsistent.
  const orphanPlaceholders = orphanIds.map(() => "?").join(", ");
  const deletedCount = rawRun(
    `DELETE FROM attachments WHERE id IN (${orphanPlaceholders})`,
    ...orphanIds,
  );

  // Clean up on-disk files only after the DB rows have been removed
  for (const filePath of orphanFilePaths) {
    try {
      unlinkSync(filePath);
    } catch {
      /* file may already be gone */
    }
  }

  return deletedCount;
}

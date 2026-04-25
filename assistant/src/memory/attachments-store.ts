/**
 * Assistant-owned attachment storage.
 *
 * Attachments uploaded ahead of message persistence are staged in the database.
 * Once linked to a message, the canonical file is materialized directly into
 * that conversation's attachments/ directory and the database row points there.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getConversationAttachmentsDirPath } from "./conversation-directories.js";
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

function resolveUniqueFilename(dir: string, filename: string): string {
  const sanitized = basename(filename);
  const existingPath = join(dir, sanitized);
  if (!existsSync(existingPath)) return sanitized;

  const ext = extname(sanitized);
  const base = basename(sanitized, ext);
  let counter = 2;
  let candidate = `${base}-${counter}${ext}`;
  while (existsSync(join(dir, candidate))) {
    counter++;
    candidate = `${base}-${counter}${ext}`;
  }
  return candidate;
}

function computeSizeBytesFromBase64(dataBase64: string): number {
  const padding = dataBase64.endsWith("==")
    ? 2
    : dataBase64.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
}

interface AttachmentRow {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  dataBase64: string;
  contentHash: string | null;
  thumbnailBase64: string | null;
  filePath: string | null;
  createdAt: number;
  sourcePath: string | null;
}

function getAttachmentRow(attachmentId: string): AttachmentRow | null {
  return (
    rawGet<AttachmentRow>(
      `SELECT
         id,
         original_filename AS originalFilename,
         mime_type AS mimeType,
         size_bytes AS sizeBytes,
         kind,
         data_base64 AS dataBase64,
         content_hash AS contentHash,
         thumbnail_base64 AS thumbnailBase64,
         file_path AS filePath,
         created_at AS createdAt,
         source_path AS sourcePath
       FROM attachments
       WHERE id = ?`,
      attachmentId,
    ) ?? null
  );
}

function getMessageConversationContext(
  messageId: string,
): { conversationId: string; conversationCreatedAt: number } | null {
  return (
    rawGet<{ conversationId: string; conversationCreatedAt: number }>(
      `SELECT
         m.conversation_id AS conversationId,
         c.created_at AS conversationCreatedAt
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ?`,
      messageId,
    ) ?? null
  );
}

function listLinkedConversationIds(attachmentId: string): string[] {
  return rawAll<{ conversationId: string }>(
    `SELECT DISTINCT m.conversation_id AS conversationId
     FROM message_attachments ma
     JOIN messages m ON m.id = ma.message_id
     WHERE ma.attachment_id = ?`,
    attachmentId,
  ).map((row) => row.conversationId);
}

function cloneAttachmentRow(row: AttachmentRow): AttachmentRow {
  const clonedId = uuid();
  const db = getDb();
  const now = Date.now();

  db.insert(attachments)
    .values({
      id: clonedId,
      originalFilename: row.originalFilename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind,
      dataBase64: row.dataBase64,
      contentHash: null,
      thumbnailBase64: row.thumbnailBase64,
      filePath: row.filePath,
      createdAt: now,
    })
    .run();

  if (row.sourcePath) {
    rawRun(
      `UPDATE attachments SET source_path = ? WHERE id = ?`,
      row.sourcePath,
      clonedId,
    );
  }

  return {
    ...row,
    id: clonedId,
    createdAt: now,
  };
}

function insertMessageAttachmentLink(
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

function persistAttachmentFilePath(
  attachmentId: string,
  targetPath: string,
  sourcePath?: string | null,
): void {
  if (sourcePath) {
    rawRun(
      `UPDATE attachments
       SET file_path = ?, data_base64 = '', source_path = COALESCE(source_path, ?)
       WHERE id = ?`,
      targetPath,
      sourcePath,
      attachmentId,
    );
    return;
  }

  rawRun(
    `UPDATE attachments SET file_path = ?, data_base64 = '' WHERE id = ?`,
    targetPath,
    attachmentId,
  );
}

function materializeAttachmentIntoConversation(
  row: AttachmentRow,
  conversationId: string,
  conversationCreatedAt: number,
): void {
  const attachDir = getConversationAttachmentsDirPath(
    conversationId,
    conversationCreatedAt,
  );
  mkdirSync(attachDir, { recursive: true });

  if (
    row.filePath &&
    existsSync(row.filePath) &&
    dirname(row.filePath) === attachDir
  ) {
    if (row.dataBase64) {
      rawRun(`UPDATE attachments SET data_base64 = '' WHERE id = ?`, row.id);
    }
    return;
  }

  const resolvedName = resolveUniqueFilename(attachDir, row.originalFilename);
  const targetPath = join(attachDir, resolvedName);

  let sourcePath = row.sourcePath;
  if (row.dataBase64) {
    writeFileSync(targetPath, Buffer.from(row.dataBase64, "base64"));
  } else {
    const readablePath = [row.filePath, row.sourcePath].find(
      (path): path is string => !!path && existsSync(path),
    );
    if (!readablePath) return;

    if (!sourcePath && readablePath !== row.filePath) {
      sourcePath = readablePath;
    } else if (
      !sourcePath &&
      readablePath === row.filePath &&
      dirname(readablePath) !== attachDir
    ) {
      sourcePath = readablePath;
    }

    copyFileSync(readablePath, targetPath);
  }

  // Remember the old file path before updating the DB row, so we can
  // clean up the staging copy (e.g. in data/attachments/) after the
  // canonical path moves to the conversation directory.
  const previousFilePath = row.filePath;

  persistAttachmentFilePath(row.id, targetPath, sourcePath);

  // Remove the old staging file now that the canonical copy lives in
  // the conversation directory.  Only delete files that live in the
  // staging area (workspace/data/attachments/).  When an attachment is
  // cloned across conversations (e.g. during a fork), previousFilePath
  // may point to another conversation's directory — deleting that would
  // cause data loss for the source conversation.
  const stagingDirRaw = join(getWorkspaceDir(), "data", "attachments");
  let stagingDir: string;
  try {
    stagingDir = existsSync(stagingDirRaw)
      ? realpathSync(stagingDirRaw)
      : stagingDirRaw;
  } catch {
    stagingDir = stagingDirRaw;
  }
  if (
    previousFilePath &&
    previousFilePath !== targetPath &&
    dirname(previousFilePath) === stagingDir &&
    existsSync(previousFilePath)
  ) {
    try {
      unlinkSync(previousFilePath);
    } catch {
      /* file may already be gone */
    }
  }
}

function scopeAttachmentToConversation(
  attachmentId: string,
  conversationId: string,
  conversationCreatedAt: number,
): string {
  let row = getAttachmentRow(attachmentId);
  if (!row) {
    throw new Error(`Attachment not found: ${attachmentId}`);
  }

  const linkedConversationIds = listLinkedConversationIds(attachmentId);
  if (linkedConversationIds.some((id) => id !== conversationId)) {
    row = cloneAttachmentRow(row);
  }

  materializeAttachmentIntoConversation(
    row,
    conversationId,
    conversationCreatedAt,
  );
  return row.id;
}

// ---------------------------------------------------------------------------
// Size and encoding limits
// ---------------------------------------------------------------------------

/** Hard ceiling on a single uploaded attachment (100 MB, matching assistant limits). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Legacy helper kept for historical backfills that still need to materialize
 * old attachment rows from inline base64 data.
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
  "image/heic",
  "image/heif",
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
 *
 * When `opts.trustedSource` is true, both the dangerous-extensions
 * blocklist and the MIME allowlist are bypassed. This is intended for
 * gateway-mediated channel ingress where the actor has already been
 * resolved to a guardian binding — the threat model behind those filters
 * (untrusted senders staging executables) does not apply when the
 * guardian themselves is the sender. Filename normalization still runs.
 */
export function validateAttachmentUpload(
  filename: string,
  mimeType: string,
  opts?: { trustedSource?: boolean },
): AttachmentValidationResult {
  // Normalize filename: trim whitespace and strip trailing dots to prevent
  // bypasses like "payload.exe " or "payload.exe."
  const normalizedFilename = filename.trim().replace(/\.+$/, "");

  if (opts?.trustedSource) {
    return { ok: true };
  }

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

// ---------------------------------------------------------------------------
// Binary upload helper (multipart / octet-stream)
// ---------------------------------------------------------------------------

/**
 * Write raw bytes to the staging directory and register as a file-backed
 * attachment. Used by the multipart/form-data and application/octet-stream
 * upload paths.
 *
 * @param filename  Original filename from the client
 * @param mimeType  MIME type of the file
 * @param bytes     Raw file content
 * @returns The stored attachment record
 */
export function uploadAttachmentFromBytes(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): StoredAttachment {
  const dir = join(getWorkspaceDir(), "data", "attachments");
  mkdirSync(dir, { recursive: true });

  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stagingFilename = `${Date.now()}-${uuid().slice(0, 8)}-${sanitized}`;
  const stagedPath = join(dir, stagingFilename);

  writeFileSync(stagedPath, bytes);

  return uploadFileBackedAttachment(
    filename,
    mimeType,
    stagedPath,
    bytes.length,
  );
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

  rawRun(`UPDATE attachments SET source_path = ? WHERE id = ?`, filePath, id);

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
 * Look up the stored file_path for an attachment by its original source_path.
 * Returns the workspace-internal file path if found, or null otherwise.
 * Useful as a fallback when the original source_path is outside the sandbox.
 */
export function getFilePathBySourcePath(
  sourcePath: string,
  conversationId: string,
): string | null {
  try {
    const row = rawGet<{ file_path: string | null }>(
      `SELECT a.file_path FROM attachments a
       JOIN message_attachments ma ON ma.attachment_id = a.id
       JOIN messages m ON m.id = ma.message_id
       WHERE a.source_path = ? AND m.conversation_id = ?
       ORDER BY a.created_at DESC LIMIT 1`,
      sourcePath,
      conversationId,
    );
    return row?.file_path ?? null;
  } catch (err) {
    // Some test contexts exercise the tool wrapper before attachment tables
    // are initialized. In that case, there is no stored fallback path to use.
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

/**
 * Return the raw binary content for an attachment by reading from its
 * on-disk file path.
 *
 * Returns null if the attachment does not exist or the file is missing.
 */
export function getAttachmentContent(attachmentId: string): Buffer | null {
  const row = getAttachmentRow(attachmentId);
  if (!row) return null;

  try {
    if (row.filePath) {
      return readFileSync(row.filePath);
    }
    if (row.dataBase64) {
      return Buffer.from(row.dataBase64, "base64");
    }
    return null;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function validateAttachmentPayload(
  dataBase64: string,
  options?: { skipSizeLimit?: boolean },
): number {
  if (!isValidBase64(dataBase64)) {
    throw new AttachmentUploadError("Invalid base64 encoding");
  }

  const sizeBytes = computeSizeBytesFromBase64(dataBase64);
  if (!options?.skipSizeLimit && sizeBytes > MAX_UPLOAD_BYTES) {
    throw new AttachmentUploadError(
      `Attachment too large: ${formatBytes(sizeBytes)} exceeds ${formatBytes(
        MAX_UPLOAD_BYTES,
      )} limit`,
    );
  }

  return sizeBytes;
}

export function uploadAttachment(
  filename: string,
  mimeType: string,
  dataBase64: string,
  sourcePath?: string,
): StoredAttachment {
  const sizeBytes = validateAttachmentPayload(dataBase64);

  const db = getDb();
  const now = Date.now();
  const kind = classifyKind(mimeType);

  const record = {
    id: uuid(),
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    dataBase64,
    filePath: null,
    contentHash: null,
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

export function attachInlineAttachmentToMessage(
  messageId: string,
  position: number,
  filename: string,
  mimeType: string,
  dataBase64: string,
  options?: { sourcePath?: string; skipSizeLimit?: boolean },
): StoredAttachment {
  const sizeBytes = validateAttachmentPayload(dataBase64, {
    skipSizeLimit: options?.skipSizeLimit,
  });
  const ctx = getMessageConversationContext(messageId);
  if (!ctx) {
    throw new Error(`Message not found: ${messageId}`);
  }

  const attachDir = getConversationAttachmentsDirPath(
    ctx.conversationId,
    ctx.conversationCreatedAt,
  );
  mkdirSync(attachDir, { recursive: true });
  const resolvedName = resolveUniqueFilename(attachDir, filename);
  const targetPath = join(attachDir, resolvedName);
  writeFileSync(targetPath, Buffer.from(dataBase64, "base64"));

  const now = Date.now();
  const id = uuid();
  const kind = classifyKind(mimeType);
  const db = getDb();

  db.insert(attachments)
    .values({
      id,
      originalFilename: filename,
      mimeType,
      sizeBytes,
      kind,
      dataBase64: "",
      filePath: targetPath,
      contentHash: null,
      createdAt: now,
    })
    .run();

  if (options?.sourcePath) {
    rawRun(
      `UPDATE attachments SET source_path = ? WHERE id = ?`,
      options.sourcePath,
      id,
    );
  }

  insertMessageAttachmentLink(messageId, id, position);

  return {
    id,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    thumbnailBase64: null,
    createdAt: now,
  };
}

export function attachFileBackedAttachmentToMessage(
  messageId: string,
  position: number,
  filename: string,
  mimeType: string,
  sourceFilePath: string,
  sizeBytes: number,
): StoredAttachment & { filePath: string } {
  const ctx = getMessageConversationContext(messageId);
  if (!ctx) {
    throw new Error(`Message not found: ${messageId}`);
  }

  const attachDir = getConversationAttachmentsDirPath(
    ctx.conversationId,
    ctx.conversationCreatedAt,
  );
  mkdirSync(attachDir, { recursive: true });
  const resolvedName = resolveUniqueFilename(attachDir, filename);
  const targetPath = join(attachDir, resolvedName);
  copyFileSync(sourceFilePath, targetPath);

  const now = Date.now();
  const id = uuid();
  const kind = classifyKind(mimeType);
  const db = getDb();

  db.insert(attachments)
    .values({
      id,
      originalFilename: filename,
      mimeType,
      sizeBytes,
      kind,
      dataBase64: "",
      filePath: targetPath,
      createdAt: now,
    })
    .run();

  rawRun(
    `UPDATE attachments SET source_path = ? WHERE id = ?`,
    sourceFilePath,
    id,
  );
  insertMessageAttachmentLink(messageId, id, position);

  return {
    id,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    thumbnailBase64: null,
    createdAt: now,
    filePath: targetPath,
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

  // An attachment row can still be shared by multiple messages inside the same
  // conversation. Only delete it when no remaining links point to the row.
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
  options?: { hydrateFileData?: boolean },
): Array<StoredAttachment & { dataBase64: string }> {
  if (ids.length === 0) return [];
  const db = getDb();
  const hydrateFileData = options?.hydrateFileData ?? false;
  const results: Array<StoredAttachment & { dataBase64: string }> = [];
  for (const id of ids) {
    const row = db
      .select()
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();
    if (row) {
      // File-backed attachments store data on disk with dataBase64 = "".
      // Only hydrate base64 from disk when callers explicitly opt in,
      // to avoid eagerly reading large files for validation-only paths.
      let dataBase64 = row.dataBase64;
      if (hydrateFileData && !dataBase64 && row.filePath) {
        try {
          dataBase64 = readFileSync(row.filePath).toString("base64");
        } catch (err: unknown) {
          const log = getLogger("attachments-store");
          log.warn(
            `Failed to read file-backed attachment ${id} from ${row.filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
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
): string {
  const ctx = getMessageConversationContext(messageId);
  if (!ctx) {
    throw new Error(`Message not found: ${messageId}`);
  }

  const scopedAttachmentId = scopeAttachmentToConversation(
    attachmentId,
    ctx.conversationId,
    ctx.conversationCreatedAt,
  );
  insertMessageAttachmentLink(messageId, scopedAttachmentId, position);
  return scopedAttachmentId;
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
  return getAttachmentsByIds(ids, { hydrateFileData: true });
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
 * Lightweight existence check — queries only the attachment ID column
 * without reading file contents from disk.
 */
export function attachmentExists(attachmentId: string): boolean {
  const db = getDb();
  const row = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();
  return !!row;
}

/**
 * Retrieve a single attachment by ID.
 */
export function getAttachmentById(
  attachmentId: string,
  options?: { hydrateFileData?: boolean },
): (StoredAttachment & { dataBase64: string }) | null {
  const results = getAttachmentsByIds([attachmentId], options);
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

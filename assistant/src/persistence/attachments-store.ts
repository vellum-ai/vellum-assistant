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
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  jpegFilenameFor,
  normalizeImageBase64,
  normalizeImageBytes,
  sniffImageFileMimeType,
} from "../util/image-conversion.js";
import { getLogger } from "../util/logger.js";
import { getConversationsDir, getWorkspaceDir } from "../util/platform.js";
import { getConversationAttachmentsDirPath } from "./conversation-directories.js";
import {
  messageMetadataTagsSightFrame,
  SIGHT_FRAME_ATTACHMENT_IDS_KEY,
} from "./conversation-types.js";
import { getDb } from "./db-connection.js";
import { rawAll, rawGet, rawRun } from "./raw-query.js";
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

export function classifyKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "document";
}

export class AttachmentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentUploadError";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveUniqueFilename(dir: string, filename: string): string {
  const sanitized = basename(filename);
  const existingPath = join(dir, sanitized);
  if (!existsSync(existingPath)) {
    return sanitized;
  }

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
      "attachments:getAttachmentRow",
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
  // Any-state read, deliberately: the id names a message the caller is
  // already linking an attachment to, and a rendered row may still be
  // streaming. Existence and ownership are the question, not completeness.
  return (
    rawGet<{ conversationId: string; conversationCreatedAt: number }>(
      "attachments:getMessageConversationContext",
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
    "attachments:listLinkedConversationIds",
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
      "attachments:cloneAttachmentRow",
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
      "attachments:persistFilePath:withSource",
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
    "attachments:persistFilePath:plain",
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
      rawRun(
        "attachments:materialize:clearData",
        `UPDATE attachments SET data_base64 = '' WHERE id = ?`,
        row.id,
      );
    }
    return;
  }

  const resolvedName = resolveUniqueFilename(attachDir, row.originalFilename);
  const targetPath = join(attachDir, resolvedName);

  // Remember the old file path before updating the DB row, so we can
  // clean up the staging copy (e.g. in data/attachments/) after the
  // canonical path moves to the conversation directory.
  const previousFilePath = row.filePath;

  let sourcePath = row.sourcePath;
  try {
    if (row.dataBase64) {
      writeFileSync(targetPath, Buffer.from(row.dataBase64, "base64"));
    } else {
      const readablePath = [row.filePath, row.sourcePath].find(
        (path): path is string => !!path && existsSync(path),
      );
      if (!readablePath) {
        return;
      }

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

    persistAttachmentFilePath(row.id, targetPath, sourcePath);
  } catch (err) {
    // Only the copy this call was making. `resolveUniqueFilename` picked a name
    // nothing occupied, so whatever sits at `targetPath` now is this attempt's
    // own work. The row's `filePath` is deliberately left alone: until the
    // update above lands it can still name the file the bytes came FROM, and
    // for a fresh clone that file belongs to another conversation.
    if (existsSync(targetPath)) {
      try {
        unlinkSync(targetPath);
      } catch {
        /* leave the copy rather than fail the failure */
      }
    }
    throw err;
  }

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
  const cloned = linkedConversationIds.some((id) => id !== conversationId);
  if (cloned) {
    row = cloneAttachmentRow(row);
  }

  try {
    materializeAttachmentIntoConversation(
      row,
      conversationId,
      conversationCreatedAt,
    );
  } catch (err) {
    if (cloned) {
      discardFailedCloneRow(row.id);
    }
    throw err;
  }
  return row.id;
}

/**
 * Drop the row a failed clone left behind, touching no file at all.
 *
 * A clone is inserted carrying the SOURCE row's `filePath`, and only a
 * successful materialization repoints it at a copy of its own. At the moment
 * materialization fails the row can therefore still name the original's file,
 * and deleting that would take the source conversation's data with it. This is
 * the hazard the staging-dir guard in
 * {@link materializeAttachmentIntoConversation} exists for, applied to the
 * other end of the same window.
 *
 * The file this attempt was creating is cleaned up by materialization itself,
 * which is the only code that knows the path it chose.
 *
 * Best effort. Rethrowing the original failure matters more than the row, and
 * the caller converts that failure into an inline fallback either way.
 */
function discardFailedCloneRow(clonedId: string): void {
  try {
    rawRun(
      "attachments:discardFailedCloneRow",
      `DELETE FROM attachments WHERE id = ?`,
      clonedId,
    );
  } catch (err) {
    getLogger("attachments-store").warn(
      { err, attachmentId: clonedId },
      "Could not discard the row left by a failed attachment clone",
    );
  }
}

/**
 * Scope a pre-uploaded attachment into a conversation WITHOUT linking it to a
 * message, returning the scoped row's metadata. Mirrors {@link createInlineAttachment}
 * for the already-uploaded case: it gives the persist path the final attachment
 * id and stored MIME/size before it serializes the message content into a
 * workspace reference. The message link is written separately once the message
 * id exists. Returns null when the attachment row cannot be read after scoping.
 */
export function scopeAttachmentToMessageConversation(
  conversationId: string,
  conversationCreatedAt: number,
  attachmentId: string,
): (StoredAttachment & { filePath: string | null }) | null {
  const scopedId = scopeAttachmentToConversation(
    attachmentId,
    conversationId,
    conversationCreatedAt,
  );
  const row = getAttachmentRow(scopedId);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    thumbnailBase64: null,
    createdAt: row.createdAt,
    filePath: row.filePath ?? null,
  };
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
  if (data.length === 0) {
    return true;
  }
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
  // Shell scripts (browsers and OS file pickers report these for .sh files)
  "application/x-sh",
  "application/x-shellscript",
  "text/x-sh",
  "text/x-shellscript",
  // Archives
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-compressed-tar",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-xz",
  "application/vnd.rar",
  "application/x-rar-compressed",
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
 * upload paths. HEIF/HEIC images are stored as JPEG masters so every client
 * surface can render them; other formats are stored verbatim.
 *
 * @param filename  Original filename from the client
 * @param mimeType  MIME type of the file
 * @param bytes     Raw file content
 * @returns The stored attachment record
 */
export async function uploadAttachmentFromBytes(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<StoredAttachment> {
  let norm = await normalizeImageBytes(mimeType, bytes);
  if (norm.converted && norm.bytes.length > MAX_UPLOAD_BYTES) {
    norm = { mimeType, bytes, converted: false };
  }
  const storedFilename = norm.converted ? jpegFilenameFor(filename) : filename;

  const dir = join(getWorkspaceDir(), "data", "attachments");
  mkdirSync(dir, { recursive: true });

  const sanitized = storedFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stagingFilename = `${Date.now()}-${uuid().slice(0, 8)}-${sanitized}`;
  const stagedPath = join(dir, stagingFilename);

  writeFileSync(stagedPath, norm.bytes);

  return uploadFileBackedAttachment(
    storedFilename,
    norm.mimeType,
    stagedPath,
    norm.bytes.length,
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
 *
 * A declared image MIME that disagrees with the file's magic bytes is
 * corrected before the row is written. Callers here pass a MIME they were
 * handed (a signal's attachment metadata, a tool's `mimeType` argument), which
 * is ultimately extension-derived — and the stored value becomes the
 * `media_type` on every replay of the message, so a wrong one makes the
 * provider reject the conversation on every later turn.
 */
export function uploadFileBackedAttachment(
  filename: string,
  mimeType: string,
  filePath: string,
  sizeBytes: number,
): StoredAttachment & { filePath: string } {
  const now = Date.now();
  const sniffed = sniffImageFileMimeType(filePath);
  const storedMimeType = sniffed && sniffed !== mimeType ? sniffed : mimeType;
  const kind = classifyKind(storedMimeType);
  const id = uuid();
  const db = getDb();

  db.insert(attachments)
    .values({
      id,
      originalFilename: filename,
      mimeType: storedMimeType,
      sizeBytes,
      kind,
      dataBase64: "",
      filePath,
      createdAt: now,
    })
    .run();

  rawRun(
    "attachments:uploadFileBacked:sourcePath",
    `UPDATE attachments SET source_path = ? WHERE id = ?`,
    filePath,
    id,
  );

  return {
    id,
    originalFilename: filename,
    mimeType: storedMimeType,
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
  if (attachmentIds.length === 0) {
    return new Map();
  }
  const placeholders = attachmentIds.map(() => "?").join(", ");
  const rows = rawAll<{ id: string; source_path: string }>(
    "attachments:getSourcePaths",
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
      "attachments:getFilePathBySourcePath",
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
 * Return the raw binary content for a stored attachment by reading from its
 * on-disk file path (or its inline base64, for legacy rows).
 *
 * Returns null if the attachment does not exist or the file is missing. To
 * resolve an image/file block's `source` (base64 or workspace reference) to
 * bytes, use `mediaSourceBytes` / `resolveMediaSourceData` in
 * `providers/media-resolve.ts`, which delegates here for the attachment route.
 */
export function getAttachmentContent(attachmentId: string): Buffer | null {
  const row = getAttachmentRow(attachmentId);
  if (!row) {
    return null;
  }

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

/**
 * HEIF/HEIC payloads are stored as JPEG masters (filename extension
 * rewritten) so every client surface can render them; anything else — and any
 * conversion whose output would break the upload size limit — passes through
 * verbatim.
 */
async function normalizeUploadedImageBase64(
  filename: string,
  mimeType: string,
  dataBase64: string,
): Promise<{ filename: string; mimeType: string; dataBase64: string }> {
  const norm = await normalizeImageBase64(mimeType, dataBase64);
  if (!norm.converted) {
    // Bytes untouched, but the declared MIME may have been sniff-corrected.
    return { filename, mimeType: norm.mimeType, dataBase64 };
  }
  if (computeSizeBytesFromBase64(norm.dataBase64) > MAX_UPLOAD_BYTES) {
    return { filename, mimeType, dataBase64 };
  }
  return {
    filename: jpegFilenameFor(filename),
    mimeType: norm.mimeType,
    dataBase64: norm.dataBase64,
  };
}

export async function uploadAttachment(
  filename: string,
  mimeType: string,
  dataBase64: string,
  sourcePath?: string,
): Promise<StoredAttachment> {
  validateAttachmentPayload(dataBase64);

  ({ filename, mimeType, dataBase64 } = await normalizeUploadedImageBase64(
    filename,
    mimeType,
    dataBase64,
  ));
  const sizeBytes = computeSizeBytesFromBase64(dataBase64);

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
      "attachments:uploadAttachment:sourcePath",
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

export interface CreateInlineAttachmentOptions {
  sourcePath?: string;
  skipSizeLimit?: boolean;
  /**
   * Store HEIF/HEIC content as a JPEG master (with the filename extension
   * rewritten) so every client surface can render it. User-sourced ingress
   * opts in; assistant-produced attachments are stored verbatim — if the
   * assistant deliberately emits a HEIC, rewriting it would be wrong.
   */
  normalizeImage?: boolean;
}

/**
 * Create an attachment row from inline base64, materialized into the
 * conversation's attachments/ directory, WITHOUT linking it to a message. The
 * caller links it separately (`insertMessageAttachmentLink`) once the message
 * id exists — which lets the persist path create the row (and learn its id,
 * normalized MIME type, and byte size) before it serializes the message
 * content into a workspace reference.
 */
export async function createInlineAttachment(
  conversationId: string,
  conversationCreatedAt: number,
  filename: string,
  mimeType: string,
  dataBase64: string,
  options?: CreateInlineAttachmentOptions,
): Promise<StoredAttachment & { filePath: string }> {
  if (options?.normalizeImage) {
    ({ filename, mimeType, dataBase64 } = await normalizeUploadedImageBase64(
      filename,
      mimeType,
      dataBase64,
    ));
  }

  const sizeBytes = validateAttachmentPayload(dataBase64, {
    skipSizeLimit: options?.skipSizeLimit,
  });

  const attachDir = getConversationAttachmentsDirPath(
    conversationId,
    conversationCreatedAt,
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
      "attachments:createInline:sourcePath",
      `UPDATE attachments SET source_path = ? WHERE id = ?`,
      options.sourcePath,
      id,
    );
  }

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

export async function attachInlineAttachmentToMessage(
  messageId: string,
  position: number,
  filename: string,
  mimeType: string,
  dataBase64: string,
  options?: CreateInlineAttachmentOptions,
): Promise<StoredAttachment & { filePath: string }> {
  const ctx = getMessageConversationContext(messageId);
  if (!ctx) {
    throw new Error(`Message not found: ${messageId}`);
  }

  const stored = await createInlineAttachment(
    ctx.conversationId,
    ctx.conversationCreatedAt,
    filename,
    mimeType,
    dataBase64,
    options,
  );
  insertMessageAttachmentLink(messageId, stored.id, position);
  return stored;
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
    "attachments:attachFileBacked:source",
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

  if (!existing) {
    return "not_found";
  }

  // An attachment row can still be shared by multiple messages inside the same
  // conversation. Only delete it when no remaining links point to the row.
  const refCount = db
    .select({ id: messageAttachments.id })
    .from(messageAttachments)
    .where(eq(messageAttachments.attachmentId, attachmentId))
    .all().length;

  if (refCount > 0) {
    return "still_referenced";
  }

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
  if (ids.length === 0) {
    return [];
  }
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

/**
 * Hydrate attachment ids into the shape a persisted user message stores:
 * base64 data plus the on-disk source path where one is known. Ids with no
 * attachment row are dropped, so a caller that needs to know an id was bad
 * compares the returned length against what it asked for.
 */
export function resolveAttachmentsForPersist(attachmentIds: string[]): Array<{
  id: string;
  filename: string;
  mimeType: string;
  data: string;
  filePath?: string;
}> {
  const resolved = getAttachmentsByIds(attachmentIds, {
    hydrateFileData: true,
  });
  const sourcePaths = getSourcePathsForAttachments(attachmentIds);
  return resolved.map((a) => ({
    id: a.id,
    filename: a.originalFilename,
    mimeType: a.mimeType,
    data: a.dataBase64,
    ...(sourcePaths.has(a.id) ? { filePath: sourcePaths.get(a.id) } : {}),
  }));
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

  if (links.length === 0) {
    return [];
  }

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

  if (links.length === 0) {
    return [];
  }

  const results: StoredAttachment[] = [];
  for (const link of links) {
    if (!link.attachmentId) {
      continue;
    }
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
    if (row) {
      results.push(row);
    }
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
  if (candidateIds.length === 0) {
    return 0;
  }

  const db = getDb();

  // Identify truly orphaned attachment IDs first (not referenced by any message)
  const placeholders = candidateIds.map(() => "?").join(", ");
  const orphanIds = rawAll<{ id: string }>(
    "attachments:deleteOrphan:select",
    `SELECT id FROM attachments WHERE id IN (${placeholders}) AND id NOT IN (SELECT attachment_id FROM message_attachments)`,
    ...candidateIds,
  ).map((row) => row.id);

  if (orphanIds.length === 0) {
    return 0;
  }

  // Collect file paths BEFORE deleting the DB rows via Drizzle
  const orphanFilePaths: string[] = [];
  for (const id of orphanIds) {
    const row = db
      .select({ filePath: attachments.filePath })
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();
    if (row?.filePath) {
      orphanFilePaths.push(row.filePath);
    }
  }

  // Delete the orphaned DB rows first — if this fails, the on-disk files
  // remain intact alongside their DB rows, so nothing is left inconsistent.
  const orphanPlaceholders = orphanIds.map(() => "?").join(", ");
  const deletedCount = rawRun(
    "attachments:deleteOrphan:delete",
    `DELETE FROM attachments WHERE id IN (${orphanPlaceholders})`,
    ...orphanIds,
  );

  // Clean up on-disk files only after the DB rows have been removed
  for (const filePath of orphanFilePaths) {
    // A path is not private to one row. A clone carries the source's
    // `filePath` until materialization repoints it, and an attachment already
    // sitting in the destination's directory is scoped without being copied at
    // all, so a surviving row can still name this file. Unlinking it then
    // destroys another conversation's data, which is what the staging-dir
    // guard in `materializeAttachmentIntoConversation` avoids at the other end
    // of the same window.
    if (attachmentFileIsCanonical(filePath)) {
      continue;
    }
    try {
      unlinkSync(filePath);
    } catch {
      /* file may already be gone */
    }
  }

  return deletedCount;
}

/** How many attachment rows name this file. */
function attachmentFilePathReferenceCount(filePath: string): number {
  return (
    rawGet<{ refCount: number }>(
      "attachments:filePathReferenceCount",
      `SELECT COUNT(*) AS refCount FROM attachments WHERE file_path = ?`,
      filePath,
    )?.refCount ?? 0
  );
}

/**
 * True when a file is one the attachment store itself wrote: either a staged
 * upload or a conversation's own `attachments/` directory.
 *
 * `file_path` is not always the store's to rewrite. `uploadFileBackedAttachment`
 * registers a file by path, and `/attachments/register` accepts any path inside
 * the workspace, so a row can name a file the user or a tool created and still
 * owns. Directory identity is the same test
 * {@link materializeAttachmentIntoConversation} uses to decide whether a file is
 * already where it belongs.
 */
function isStoreOwnedAttachmentFile(filePath: string): boolean {
  const dir = dirname(filePath);
  if (dir === join(getWorkspaceDir(), "data", "attachments")) {
    return true;
  }
  return (
    basename(dir) === "attachments" &&
    dirname(dirname(dir)) === getConversationsDir()
  );
}

export interface SightFrameSweepCandidate {
  id: string;
  /** Stored size before the sweep, so a caller can report what it freed. */
  sizeBytes: number;
  /**
   * This row's half of the keyset key. A caller that stops part way through a
   * page resumes from the candidate it stopped on, not from the page's end.
   */
  createdAt: number;
}

/**
 * Where a scan of the candidate set stopped. `(created_at, id)` because
 * `created_at` alone is not unique: frames captured inside the same millisecond
 * would be skipped or repeated by a cursor that could not tell them apart.
 */
export interface SightFrameSweepCursor {
  createdAt: number;
  id: string;
}

export interface SightFrameSweepPage {
  candidates: SightFrameSweepCandidate[];
  /**
   * Key of the last attachment the page EXAMINED, which is not always the last
   * candidate: one the prefilter matched and the tag check rejected has to be
   * stepped over too, or the next page starts on it again.
   */
  nextCursor: SightFrameSweepCursor | null;
  /** Whether the page filled its limit, so more attachments may follow. */
  hasMore: boolean;
  /**
   * Rows the page's queries actually read: the attachments it scanned plus the
   * linked-message metadata it had to check to tell candidates from prefilter
   * near-misses. A caller bounding its work per pass charges this rather than
   * the candidate count, because a backlog of near-misses costs real queries
   * while producing no candidates at all.
   */
  rowsRead: number;
}

/**
 * One page of sight-tagged image attachments older than `createdBefore` whose
 * stored bytes still exceed `largerThanBytes`.
 *
 * The population is EVERY tagged frame, standalone camera keeps and the frames
 * that rode a spoken turn alike. That is deliberately wider than
 * `messageMetadataIsAmbientSightKeep`, which additionally requires `scripted`
 * because it answers a question about memory. Bytes on disk cost the same
 * whoever was speaking when the camera sampled them.
 *
 * Like the other metadata prefilters, the `LIKE` only narrows: each attachment
 * the prefilter admits has its linked messages parsed, and it is a candidate
 * only when one of them actually names it, so a message that merely mentions
 * the key contributes nothing.
 *
 * The prefilter lives inside an `EXISTS` rather than a join, so the page is one
 * row per ATTACHMENT. A join emits one row per link, and an attachment carried
 * by several messages would then appear several times under a single
 * `(created_at, id)` key. A page ending on such a row advances the cursor past
 * the attachment on the strength of whichever link happened to land last, and
 * the next page's strict `>` excludes the link that would have qualified it, for
 * good. A key that names one row is what makes the cursor safe.
 *
 * Age comes from the attachment row's own `created_at`, not the message's. It
 * dates the bytes this row stores, which is what the sweep is bounding: a fork's
 * clone is a second copy written on the day of the fork, however old the frame
 * it depicts.
 *
 * `after` resumes an ascending scan past an attachment already examined. A
 * caller that cannot act on what it finds (a shared file, a rendering that came
 * out no smaller) has no way to make the row stop matching, so a query that
 * always starts at the oldest row would hand back the same refusals forever and
 * never reach anything behind them.
 */
export function selectSightFrameSweepCandidates(options: {
  createdBefore: number;
  largerThanBytes: number;
  limit: number;
  after?: SightFrameSweepCursor | null;
}): SightFrameSweepPage {
  const after = options.after ?? null;
  const taggedMessageLike = `%"${SIGHT_FRAME_ATTACHMENT_IDS_KEY}"%`;
  const rows = rawAll<{
    id: string;
    sizeBytes: number;
    createdAt: number;
  }>(
    "attachments:selectSightFrameSweepCandidates",
    `SELECT
       a.id AS id,
       a.size_bytes AS sizeBytes,
       a.created_at AS createdAt
     FROM attachments a
     WHERE a.kind = 'image'
       AND a.created_at < ?
       AND a.size_bytes > ?
       AND (? IS NULL OR (a.created_at, a.id) > (?, ?))
       AND EXISTS (
         SELECT 1
         FROM message_attachments ma
         JOIN messages m ON m.id = ma.message_id
         WHERE ma.attachment_id = a.id
           AND m.metadata LIKE ?
       )
     ORDER BY a.created_at ASC, a.id ASC
     LIMIT ?`,
    options.createdBefore,
    options.largerThanBytes,
    after === null ? null : 1,
    after?.createdAt ?? 0,
    after?.id ?? "",
    taggedMessageLike,
    options.limit,
  );

  const candidates: SightFrameSweepCandidate[] = [];
  let nextCursor: SightFrameSweepCursor | null = null;
  let rowsRead = rows.length;
  for (const row of rows) {
    nextCursor = { createdAt: row.createdAt, id: row.id };
    const linked = rawAll<{ metadata: string | null }>(
      "attachments:sightFrameSweepCandidateTags",
      `SELECT m.metadata AS metadata
       FROM message_attachments ma
       JOIN messages m ON m.id = ma.message_id
       WHERE ma.attachment_id = ?
         AND m.metadata LIKE ?`,
      row.id,
      taggedMessageLike,
    );
    rowsRead += linked.length;
    const tagged = linked.some((link) =>
      messageMetadataTagsSightFrame(link.metadata, row.id),
    );
    if (!tagged) {
      continue;
    }
    candidates.push({
      id: row.id,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
    });
  }
  return {
    candidates,
    nextCursor,
    hasMore: rows.length === options.limit,
    rowsRead,
  };
}

/**
 * Sibling of an attachment file holding the bytes a shrink is replacing, until
 * the row has been updated to describe the replacement. Fixed rather than
 * random, so one a killed process left behind is reclaimed by the next attempt
 * on that row rather than accumulating.
 */
export const SWEEP_BACKUP_SUFFIX = ".sweep-bak";

/** Sibling a shrink writes its replacement into before renaming it into place. */
export const SWEEP_TEMP_SUFFIX = ".sweep-tmp";

export type ReclaimBackupResult = "deleted" | "restored" | "kept" | "failed";

/**
 * True while some attachment row names this exact file as its canonical bytes.
 *
 * The suffixes a shrink appends are not reserved. A file the user picked can be
 * called `holiday.jpg.sweep-bak`, `resolveUniqueFilename` stores it under that
 * name in the very directory the reclaim scans, and `/attachments/register`
 * accepts any workspace path at all. So nothing may be deleted for looking like
 * a sidecar: what settles it is whether a row is pointing at it.
 */
export function attachmentFileIsCanonical(filePath: string): boolean {
  return attachmentFilePathReferenceCount(filePath) > 0;
}

/**
 * Deal with a `.sweep-bak` left behind by a process that died mid-shrink.
 *
 * A backup exists only between the moment a shrink renames the original aside
 * and the moment it unlinks it, so where in that window the process died is what
 * decides the bytes' fate. The rows answer it, in five cases:
 *
 *  1. The backup path is ITSELF some row's canonical file, because a filename
 *     may legitimately end in the suffix. KEEP: this is not a sidecar at all,
 *     and deleting it would destroy an attachment the transcript still renders.
 *  2. The base file is MISSING and a row still names it. The crash landed
 *     between the two renames, so the row points at nothing and
 *     {@link getAttachmentContent} returns null for good. RESTORE the backup
 *     over the base: the frame reads again, and its size still exceeds the
 *     sweep's threshold, so the row stays a candidate and converges normally.
 *  3. The base file is MISSING and no row names it. The row was deleted while
 *     its backup was out of place, so nothing can ever read either. Garbage.
 *  4. A row OVERSTATES the file in place, so the row update never landed. This
 *     is the crash-convergence state on {@link shrinkAttachmentBytes}: the row
 *     still selects, and the next shrink attempt renames over this backup under
 *     its fixed name. KEEP, because until then it is the only full copy.
 *  5. A row already DESCRIBES the file in place (or no row names it at all), so
 *     the update landed and only the unlink was lost. The backup is spent.
 *     Garbage.
 *
 * Never call this while a shrink on the same attachment is in flight; the sweep
 * that drives both runs them in sequence.
 */
export function reclaimAttachmentSweepBackup(
  backupPath: string,
): ReclaimBackupResult {
  if (!backupPath.endsWith(SWEEP_BACKUP_SUFFIX)) {
    return "kept";
  }
  if (attachmentFileIsCanonical(backupPath)) {
    return "kept";
  }
  const filePath = backupPath.slice(0, -SWEEP_BACKUP_SUFFIX.length);

  let storedBytes: number | null = null;
  try {
    storedBytes = statSync(filePath).size;
  } catch {
    storedBytes = null;
  }

  if (storedBytes === null) {
    if (!attachmentFileIsCanonical(filePath)) {
      return deleteSweepLeftover(backupPath);
    }
    try {
      renameSync(backupPath, filePath);
      return "restored";
    } catch {
      return "failed";
    }
  }

  const owners = rawGet<{ rows: number; overstating: number }>(
    "attachments:sweepBackupOwners",
    `SELECT
       COUNT(*) AS rows,
       COALESCE(SUM(CASE WHEN size_bytes > ? THEN 1 ELSE 0 END), 0) AS overstating
     FROM attachments
     WHERE file_path = ?`,
    storedBytes,
    filePath,
  );
  if (owners && owners.rows > 0 && owners.overstating > 0) {
    return "kept";
  }
  return deleteSweepLeftover(backupPath);
}

/**
 * Remove a file the reclaim has decided is debris, refusing any that a row
 * claims as its canonical bytes. Callers reach it having already made that
 * check; it repeats it because deleting an attachment's only copy is the one
 * mistake this machinery must not be able to make.
 */
export function deleteSweepLeftover(path: string): ReclaimBackupResult {
  if (attachmentFileIsCanonical(path)) {
    return "kept";
  }
  try {
    unlinkSync(path);
    return "deleted";
  } catch {
    return "failed";
  }
}

/**
 * Why an attachment's bytes are not this store's to rewrite. Every one of these
 * is decidable from the row alone, before a caller spends anything on producing
 * a replacement.
 */
export type ShrinkAttachmentRefusal =
  | "not_found"
  | "no_content"
  | "shared_file"
  | "foreign_file"
  | "sidecar_conflict";

export type ShrinkAttachmentResult =
  | ShrinkAttachmentRefusal
  | "shrunk"
  | "not_smaller"
  | "write_failed";

/**
 * The refusals {@link shrinkAttachmentBytes} would answer with, decided without
 * touching the bytes:
 *
 *  - a `file_path` more than one row names. A path is not private to a row (see
 *    {@link deleteOrphanAttachments}), and rewriting a shared file would rewrite
 *    the other row's image too. Writing a fresh file and repointing only this
 *    row would avoid the corruption but strand the original, which nothing
 *    unlinks until its last row is deleted, so refusing is the option that
 *    actually bounds storage.
 *  - a file outside the store's own directories, which may be a file the user
 *    or a tool still owns.
 *  - a file whose sidecar names are already some other row's canonical bytes.
 *    The suffixes are derived, not reserved: a file called `holiday.jpg` and one
 *    called `holiday.jpg.sweep-bak` can both be real attachments in one
 *    directory, and shrinking the first would write over the second. Refusing
 *    costs one frame its shrink; overwriting costs the other its only copy.
 *  - a row holding neither a file nor inline bytes.
 *
 * Exported so a caller that has to PRODUCE the smaller rendering can ask first
 * and skip the work. The shrink applies the same predicate itself, so the check
 * is an optimization and never the enforcement.
 */
export function attachmentShrinkRefusal(
  attachmentId: string,
): ShrinkAttachmentRefusal | null {
  const row = getAttachmentRow(attachmentId);
  return row ? refusalForRow(row) : "not_found";
}

function refusalForRow(row: AttachmentRow): ShrinkAttachmentRefusal | null {
  if (row.filePath) {
    if (!isStoreOwnedAttachmentFile(row.filePath)) {
      return "foreign_file";
    }
    if (attachmentFilePathReferenceCount(row.filePath) > 1) {
      return "shared_file";
    }
    if (sweepSidecarsAreClaimed(row.filePath)) {
      return "sidecar_conflict";
    }
    return null;
  }
  return row.dataBase64 ? null : "no_content";
}

/** True when either sidecar name this file would use is another row's canonical file. */
function sweepSidecarsAreClaimed(filePath: string): boolean {
  return (
    (rawGet<{ claimed: number }>(
      "attachments:sweepSidecarsClaimed",
      `SELECT COUNT(*) AS claimed FROM attachments WHERE file_path IN (?, ?)`,
      `${filePath}${SWEEP_TEMP_SUFFIX}`,
      `${filePath}${SWEEP_BACKUP_SUFFIX}`,
    )?.claimed ?? 0) > 0
  );
}

/**
 * Replace an attachment's stored bytes with a smaller rendering of the same
 * image, leaving the row, its links, and its message content in place.
 *
 * Refuses everything {@link attachmentShrinkRefusal} names, plus bytes that are
 * not smaller than what is stored, so a rendering that cannot win leaves the
 * original alone.
 *
 * A row still holding its bytes inline is rewritten too, rather than skipped.
 * That shape is degraded (materialization found nothing readable to copy and
 * left the staged row as it was), and it is the one shape where the bytes sit in
 * the database itself, which is the last place an image nobody chose to send
 * should grow unbounded. Nothing aliases an inline payload the way a file path
 * can be aliased: a clone copies the string into a row of its own. Its bytes and
 * their description go into one statement, so there is no window where the row
 * can disagree with what it holds.
 *
 * A file-backed row has no such single statement available, so the order is
 * chosen for what a failure leaves behind. The original is renamed aside to a
 * `.sweep-bak` sibling, the replacement is renamed into place, and only then is
 * the row updated; a throw from that update puts the backup back, so the file
 * and the row still agree. The backup name is fixed rather than random so that
 * one left by a killed process is reclaimed by the next attempt on the same row
 * instead of accumulating. Callers must serialize their calls per attachment;
 * the sweep that drives this runs one pass at a time.
 *
 * NEVER reorder this to update the row first. The window that ordering opens is
 * the unrecoverable one: a process killed between a DB-first update and the
 * file rename leaves the row claiming a thumbnail's size while the full-size
 * file is still there, which puts the row UNDER the size threshold the sweep
 * selects on, so nothing ever looks at it again and
 * `/attachments/:id/content` serves that understated size as `Content-Length`
 * forever.
 *
 * The order used here self-heals instead. A process killed after the rename but
 * before the update leaves a thumbnail on disk under a row still claiming the
 * original size, which is ABOVE the threshold, so the sweep re-selects the row.
 * {@link getAttachmentContent} reads the file rather than trusting `sizeBytes`,
 * so the next pass re-encodes the thumbnail that is actually there, and the
 * not-smaller check compares that against the stale, larger stored size and
 * lets it through. One more pass and the row describes what it stores.
 *
 * A process killed in the other window, after the update and before the backup
 * is unlinked, leaves a full-size backup beside a row that no longer selects.
 * {@link reclaimAttachmentSweepBackup} is what collects those.
 */
export function shrinkAttachmentBytes(
  attachmentId: string,
  bytes: Uint8Array,
  mimeType: string,
): ShrinkAttachmentResult {
  const row = getAttachmentRow(attachmentId);
  if (!row) {
    return "not_found";
  }
  const refusal = refusalForRow(row);
  if (refusal) {
    return refusal;
  }
  if (bytes.length >= row.sizeBytes) {
    return "not_smaller";
  }

  const describedBy = {
    sizeBytes: bytes.length,
    mimeType,
    kind: classifyKind(mimeType),
    originalFilename:
      mimeType === "image/jpeg" && row.mimeType !== "image/jpeg"
        ? jpegFilenameFor(row.originalFilename)
        : row.originalFilename,
  };
  const db = getDb();

  if (!row.filePath) {
    db.update(attachments)
      .set({
        ...describedBy,
        dataBase64: Buffer.from(bytes).toString("base64"),
      })
      .where(eq(attachments.id, attachmentId))
      .run();
    return "shrunk";
  }

  const filePath = row.filePath;
  const tmpPath = `${filePath}${SWEEP_TEMP_SUFFIX}`;
  const bakPath = `${filePath}${SWEEP_BACKUP_SUFFIX}`;
  try {
    writeFileSync(tmpPath, bytes);
    renameSync(filePath, bakPath);
    renameSync(tmpPath, filePath);
  } catch {
    if (!existsSync(filePath) && existsSync(bakPath)) {
      try {
        renameSync(bakPath, filePath);
      } catch {
        /* the backup is the original, still readable under its own name */
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      /* nothing was written */
    }
    return "write_failed";
  }

  try {
    db.update(attachments)
      .set(describedBy)
      .where(eq(attachments.id, attachmentId))
      .run();
  } catch (err) {
    let restoreErr: unknown;
    try {
      renameSync(bakPath, filePath);
    } catch (caught) {
      restoreErr = caught;
    }
    getLogger("attachments-store").warn(
      { err, restoreErr, attachmentId },
      "Could not record a shrunk attachment's new size; restored its original bytes",
    );
    return "write_failed";
  }

  try {
    unlinkSync(bakPath);
  } catch {
    /* reclaimed by the next attempt on this row */
  }
  return "shrunk";
}

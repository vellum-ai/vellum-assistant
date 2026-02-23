/**
 * Assistant-owned attachment storage.
 *
 * Stores attachments in the local SQLite database with base64-encoded
 * data. Provides upload, delete, and message-linkage operations.
 */

import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { attachments, messageAttachments } from './schema.js';

export interface StoredAttachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  thumbnailBase64: string | null;
  storageKind: 'inline_base64' | 'file';
  filePath: string | null;
  sha256: string | null;
  expiresAt: number | null;
  createdAt: number;
}

function classifyKind(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

export class AttachmentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentUploadError';
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

/** Hard ceiling on a single uploaded attachment (20 MB, matching assistant limits). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/bmp', 'image/tiff', 'image/x-icon',
  // Audio
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac',
  'audio/aac', 'audio/x-m4a', 'audio/mp4',
  // Video
  'video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg',
  // Documents
  'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
  'text/html', 'text/css', 'application/json', 'application/xml', 'text/xml',
  // Source code
  'text/javascript', 'text/typescript',
  // Archives
  'application/zip', 'application/gzip', 'application/x-tar',
  'application/x-7z-compressed',
  // Office
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Fallback for unknown-but-not-dangerous files (Telegram often uses this)
  'application/octet-stream',
]);

/**
 * File extensions that are always rejected regardless of claimed MIME type.
 */
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'sh', 'bat', 'cmd', 'com', 'msi', 'iso',
  'dmg', 'app', 'scr', 'pif', 'vbs', 'ps1', 'jar',
  'cpl', 'inf', 'reg', 'hta', 'wsf', 'wsh',
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
  const normalizedFilename = filename.trim().replace(/\.+$/, '');

  const dot = normalizedFilename.lastIndexOf('.');
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
  const normalised = mimeType.toLowerCase().trim().split(';')[0].trim();
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

export function uploadAttachment(
  filename: string,
  mimeType: string,
  dataBase64: string,
): StoredAttachment {
  if (!isValidBase64(dataBase64)) {
    throw new AttachmentUploadError('Invalid base64 encoding');
  }

  const padding = dataBase64.endsWith('==') ? 2 : (dataBase64.endsWith('=') ? 1 : 0);
  const sizeBytes = Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);

  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new AttachmentUploadError(
      `Attachment too large: ${formatBytes(sizeBytes)} exceeds ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
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
      storageKind: attachments.storageKind,
      filePath: attachments.filePath,
      sha256: attachments.sha256,
      expiresAt: attachments.expiresAt,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(eq(attachments.contentHash, contentHash))
    .get();

  if (existing) {
    return { ...existing, storageKind: existing.storageKind as 'inline_base64' | 'file' };
  }

  const now = Date.now();
  const kind = classifyKind(mimeType);

  const record = {
    id: uuid(),
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    dataBase64,
    contentHash,
    createdAt: now,
  };

  db.insert(attachments).values(record).run();

  return {
    id: record.id,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    thumbnailBase64: null,
    storageKind: 'inline_base64' as const,
    filePath: null,
    sha256: null,
    expiresAt: null,
    createdAt: now,
  };
}

/**
 * Update the thumbnail for an existing attachment.
 */
export function setAttachmentThumbnail(attachmentId: string, thumbnailBase64: string): void {
  const db = getDb();
  db.update(attachments)
    .set({ thumbnailBase64 })
    .where(eq(attachments.id, attachmentId))
    .run();
}

export type DeleteAttachmentResult = 'deleted' | 'not_found' | 'still_referenced';

export function deleteAttachment(attachmentId: string): DeleteAttachmentResult {
  const db = getDb();
  const existing = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();

  if (!existing) return 'not_found';

  // With content-hash deduplication, multiple messages may reference the same
  // attachment row. Only delete the attachment (and cascade its links) when no
  // message_attachments rows still point to it.
  const refCount = db
    .select({ id: messageAttachments.id })
    .from(messageAttachments)
    .where(eq(messageAttachments.attachmentId, attachmentId))
    .all()
    .length;

  if (refCount > 0) return 'still_referenced';

  db.delete(attachments)
    .where(eq(attachments.id, attachmentId))
    .run();

  return 'deleted';
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
      results.push({
        id: row.id,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
        thumbnailBase64: row.thumbnailBase64,
        storageKind: row.storageKind as 'inline_base64' | 'file',
        filePath: row.filePath,
        sha256: row.sha256,
        expiresAt: row.expiresAt,
        dataBase64: row.dataBase64,
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
    .select({ attachmentId: messageAttachments.attachmentId, position: messageAttachments.position })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .orderBy(messageAttachments.position)
    .all();

  if (links.length === 0) return [];

  const ids = links.map((l) => l.attachmentId).filter((id): id is string => id !== null);
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
        storageKind: attachments.storageKind,
        filePath: attachments.filePath,
        sha256: attachments.sha256,
        expiresAt: attachments.expiresAt,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(eq(attachments.id, link.attachmentId))
      .get();
    if (row) results.push({ ...row, storageKind: row.storageKind as 'inline_base64' | 'file' });
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
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  const placeholders = candidateIds.map(() => '?').join(', ');
  const stmt = raw.prepare(
    `DELETE FROM attachments WHERE id IN (${placeholders}) AND id NOT IN (SELECT attachment_id FROM message_attachments)`,
  );
  const result = stmt.run(...candidateIds);
  return result.changes;
}

// ---------------------------------------------------------------------------
// File-backed attachment operations
// ---------------------------------------------------------------------------

/**
 * Create a file-backed attachment record. The actual file content lives on
 * disk at `filePath`; the DB row stores only metadata.
 */
export function createFileBackedAttachment(params: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  filePath: string;
  sha256?: string;
  expiresAt?: number;
  thumbnailBase64?: string;
}): StoredAttachment {
  const db = getDb();
  const now = Date.now();
  const kind = classifyKind(params.mimeType);
  const id = uuid();

  const record = {
    id,
    originalFilename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    kind,
    dataBase64: '',
    storageKind: 'file' as const,
    filePath: params.filePath,
    sha256: params.sha256 ?? null,
    expiresAt: params.expiresAt ?? null,
    thumbnailBase64: params.thumbnailBase64 ?? null,
    createdAt: now,
  };

  db.insert(attachments).values(record).run();

  return {
    id,
    originalFilename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    kind,
    thumbnailBase64: params.thumbnailBase64 ?? null,
    storageKind: 'file',
    filePath: params.filePath,
    sha256: params.sha256 ?? null,
    expiresAt: params.expiresAt ?? null,
    createdAt: now,
  };
}

/**
 * Return file-backed attachments whose retention period has elapsed.
 */
export function getExpiredFileAttachments(): Array<{ id: string; filePath: string }> {
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  const now = Date.now();
  const rows = raw
    .prepare(
      `SELECT id, file_path FROM attachments WHERE storage_kind = 'file' AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .all(now) as Array<{ id: string; file_path: string }>;
  return rows.map((r) => ({ id: r.id, filePath: r.file_path }));
}

/**
 * Delete a file-backed attachment's DB row. The caller is responsible for
 * removing the file on disk.
 */
export function deleteFileBackedAttachment(attachmentId: string): 'deleted' | 'not_found' {
  const db = getDb();
  const existing = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();

  if (!existing) return 'not_found';

  db.delete(attachments)
    .where(eq(attachments.id, attachmentId))
    .run();

  return 'deleted';
}

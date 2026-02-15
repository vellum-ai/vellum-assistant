/**
 * Assistant-owned attachment storage.
 *
 * Stores attachments in the local SQLite database with base64-encoded
 * data. Provides upload, delete, and message-linkage operations.
 */

import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { attachments, messageAttachments } from './schema.js';

export interface StoredAttachment {
  id: string;
  assistantId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  createdAt: number;
}

function classifyKind(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  return 'document';
}

export function uploadAttachment(
  assistantId: string,
  filename: string,
  mimeType: string,
  dataBase64: string,
): StoredAttachment {
  const db = getDb();
  const now = Date.now();
  const padding = dataBase64.endsWith('==') ? 2 : (dataBase64.endsWith('=') ? 1 : 0);
  const sizeBytes = Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
  const kind = classifyKind(mimeType);

  const record = {
    id: uuid(),
    assistantId,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    dataBase64,
    createdAt: now,
  };

  db.insert(attachments).values(record).run();

  return {
    id: record.id,
    assistantId,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    kind,
    createdAt: now,
  };
}

export function deleteAttachment(assistantId: string, attachmentId: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.assistantId, assistantId),
      ),
    )
    .get();

  if (!existing) return false;

  db.delete(attachments)
    .where(eq(attachments.id, attachmentId))
    .run();

  return true;
}

export function getAttachmentsByIds(
  assistantId: string,
  ids: string[],
): Array<StoredAttachment & { dataBase64: string }> {
  if (ids.length === 0) return [];
  const db = getDb();
  const results: Array<StoredAttachment & { dataBase64: string }> = [];
  for (const id of ids) {
    const row = db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.assistantId, assistantId),
        ),
      )
      .get();
    if (row) {
      results.push({
        id: row.id,
        assistantId: row.assistantId,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
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
  assistantId: string,
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
  return getAttachmentsByIds(assistantId, ids);
}

/**
 * Return all attachments linked to a message without assistant scoping.
 * Used by the desktop IPC history handler where tenant isolation is not needed.
 */
export function getAttachmentsForMessageUnscoped(
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

  const results: Array<StoredAttachment & { dataBase64: string }> = [];
  for (const link of links) {
    if (!link.attachmentId) continue;
    const row = db
      .select()
      .from(attachments)
      .where(eq(attachments.id, link.attachmentId))
      .get();
    if (row) {
      results.push({
        id: row.id,
        assistantId: row.assistantId,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
        dataBase64: row.dataBase64,
        createdAt: row.createdAt,
      });
    }
  }
  return results;
}

/**
 * Retrieve a single attachment by ID, scoped to an assistant.
 */
export function getAttachmentById(
  assistantId: string,
  attachmentId: string,
): (StoredAttachment & { dataBase64: string }) | null {
  const results = getAttachmentsByIds(assistantId, [attachmentId]);
  return results[0] ?? null;
}

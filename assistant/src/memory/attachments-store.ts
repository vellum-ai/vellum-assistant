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
  const sizeBytes = Math.ceil((dataBase64.length * 3) / 4);
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

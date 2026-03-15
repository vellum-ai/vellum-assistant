import { eq } from "drizzle-orm";

import { getDb } from "./db.js";
import { memoryCheckpoints } from "./schema.js";

export interface MessageCursorCheckpoint {
  createdAt: number;
  messageId: string;
}

export function getMemoryCheckpoint(key: string): string | null {
  const db = getDb();
  const row = db
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(eq(memoryCheckpoints.key, key))
    .get();
  return row?.value ?? null;
}

export function setMemoryCheckpoint(key: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(memoryCheckpoints)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: memoryCheckpoints.key,
      set: { value, updatedAt: now },
    })
    .run();
}

export function deleteMemoryCheckpoint(key: string): void {
  const db = getDb();
  db.delete(memoryCheckpoints).where(eq(memoryCheckpoints.key, key)).run();
}

export function readMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
): MessageCursorCheckpoint {
  const createdAt =
    Number.parseInt(getMemoryCheckpoint(createdAtKey) ?? "0", 10) || 0;
  const messageId = getMemoryCheckpoint(messageIdKey) ?? "";
  return { createdAt, messageId };
}

export function writeMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
  checkpoint: MessageCursorCheckpoint,
): void {
  setMemoryCheckpoint(createdAtKey, String(checkpoint.createdAt));
  setMemoryCheckpoint(messageIdKey, checkpoint.messageId);
}

export function resetMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
): void {
  writeMessageCursorCheckpoint(createdAtKey, messageIdKey, {
    createdAt: 0,
    messageId: "",
  });
}

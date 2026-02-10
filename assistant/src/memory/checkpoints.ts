import { eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { memoryCheckpoints } from './schema.js';

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

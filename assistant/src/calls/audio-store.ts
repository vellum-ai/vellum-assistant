import { randomUUID } from "node:crypto";

interface AudioEntry {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

const store = new Map<string, AudioEntry>();
const MAX_STORE_BYTES = 50 * 1024 * 1024; // 50MB cap
const TTL_MS = 60_000; // 60 seconds

let currentBytes = 0;

export function storeAudio(
  buffer: Buffer,
  format: "mp3" | "wav" | "opus",
): string {
  evictExpired();
  // Evict oldest if over capacity
  while (currentBytes + buffer.length > MAX_STORE_BYTES && store.size > 0) {
    const oldest = store.keys().next().value;
    if (oldest) removeEntry(oldest);
  }
  const id = randomUUID();
  const contentType =
    format === "mp3"
      ? "audio/mpeg"
      : format === "wav"
        ? "audio/wav"
        : "audio/opus";
  store.set(id, { buffer, contentType, expiresAt: Date.now() + TTL_MS });
  currentBytes += buffer.length;
  return id;
}

export function getAudio(
  id: string,
): { buffer: Buffer; contentType: string } | null {
  evictExpired();
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    removeEntry(id);
    return null;
  }
  return { buffer: entry.buffer, contentType: entry.contentType };
}

function removeEntry(id: string): void {
  const entry = store.get(id);
  if (entry) {
    currentBytes -= entry.buffer.length;
    store.delete(id);
  }
}

function evictExpired(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now > entry.expiresAt) removeEntry(id);
  }
}

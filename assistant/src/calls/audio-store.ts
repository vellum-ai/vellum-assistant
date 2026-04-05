import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getDataDir } from "../util/platform.js";

// ---------------------------------------------------------------------------
// Unified metadata — both stored and streaming entries share one map
// ---------------------------------------------------------------------------

interface AudioEntryMeta {
  filePath: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: number;
  complete: boolean;
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
}

const entries = new Map<string, AudioEntryMeta>();
const MAX_STORE_BYTES = 50 * 1024 * 1024; // 50MB cap
const TTL_MS = 60_000; // 60 seconds

let currentBytes = 0;
let spoolDir: string | null = null;

function getSpoolDir(): string {
  if (!spoolDir) {
    spoolDir = join(getDataDir(), "audio-spool");
    mkdirSync(spoolDir, { recursive: true });
    // Purge leftover files from prior unclean exits so stale audio
    // does not accumulate outside of the tracked eviction budget.
    try {
      for (const name of readdirSync(spoolDir)) {
        try {
          unlinkSync(join(spoolDir, name));
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
  }
  return spoolDir;
}

// ---------------------------------------------------------------------------
// Store complete audio — writes buffer to disk immediately
// ---------------------------------------------------------------------------

export function storeAudio(
  buffer: Buffer,
  format: "mp3" | "wav" | "opus",
): string {
  evictExpired();
  evictForCapacity(buffer.length);

  const id = randomUUID();
  const contentType = contentTypeForFormat(format);
  const filePath = join(getSpoolDir(), id);
  writeFileSync(filePath, buffer);

  entries.set(id, {
    filePath,
    contentType,
    sizeBytes: buffer.length,
    expiresAt: Date.now() + TTL_MS,
    complete: true,
    subscribers: new Set(),
  });
  currentBytes += buffer.length;
  return id;
}

// ---------------------------------------------------------------------------
// Streaming entries — audio is pushed chunk-by-chunk while being served
// ---------------------------------------------------------------------------

export interface StreamingAudioHandle {
  audioId: string;
  push: (chunk: Uint8Array) => void;
  finalize: () => void;
}

export function createStreamingEntry(
  format: "mp3" | "wav" | "opus",
): StreamingAudioHandle {
  evictExpired();
  const id = randomUUID();
  const contentType = contentTypeForFormat(format);
  const filePath = join(getSpoolDir(), id);

  // Create an empty file for appending
  writeFileSync(filePath, Buffer.alloc(0));

  const entry: AudioEntryMeta = {
    filePath,
    contentType,
    sizeBytes: 0,
    expiresAt: Date.now() + TTL_MS,
    complete: false,
    subscribers: new Set(),
  };
  entries.set(id, entry);

  return {
    audioId: id,
    push(chunk: Uint8Array) {
      // Guard: entry may have been evicted (TTL/capacity) while the
      // producer is still pushing. Silently drop the chunk so we don't
      // write to an untracked file or corrupt currentBytes accounting.
      if (!entries.has(id)) return;

      appendFileSync(filePath, chunk);
      entry.sizeBytes += chunk.byteLength;
      currentBytes += chunk.byteLength;

      for (const controller of entry.subscribers) {
        try {
          controller.enqueue(chunk);
        } catch {
          entry.subscribers.delete(controller);
        }
      }
    },
    finalize() {
      if (!entries.has(id)) return;

      entry.complete = true;
      for (const controller of entry.subscribers) {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
      entry.subscribers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Retrieval — handles both regular and streaming entries
// ---------------------------------------------------------------------------

export type AudioResult =
  | { type: "file"; filePath: string; sizeBytes: number; contentType: string }
  | { type: "stream"; stream: ReadableStream<Uint8Array>; contentType: string };

export function getAudio(id: string): AudioResult | null {
  evictExpired();

  const entry = entries.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    removeEntry(id);
    return null;
  }

  if (entry.complete) {
    return {
      type: "file",
      filePath: entry.filePath,
      sizeBytes: entry.sizeBytes,
      contentType: entry.contentType,
    };
  }

  // Still streaming — return a ReadableStream that replays existing bytes
  // from disk then subscribes for future chunks.
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      // Sync read ensures no chunks are missed between read and subscribe
      const existing = readFileSync(entry.filePath);
      if (existing.length > 0) {
        controller.enqueue(new Uint8Array(existing));
      }
      if (entry.complete) {
        controller.close();
      } else {
        entry.subscribers.add(controller);
      }
    },
    cancel() {
      entry.subscribers.delete(ctrl);
    },
  });

  return { type: "stream", stream, contentType: entry.contentType };
}

// ---------------------------------------------------------------------------
// Cleanup — call on daemon shutdown to remove all temp files
// ---------------------------------------------------------------------------

export function cleanupAudioSpool(): void {
  for (const [id] of entries) {
    removeEntry(id);
  }
  const dir = spoolDir;
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  spoolDir = null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function contentTypeForFormat(format: "mp3" | "wav" | "opus"): string {
  return format === "mp3"
    ? "audio/mpeg"
    : format === "wav"
      ? "audio/wav"
      : "audio/opus";
}

function removeEntry(id: string): void {
  const entry = entries.get(id);
  if (entry) {
    for (const controller of entry.subscribers) {
      try {
        controller.close();
      } catch {
        // noop
      }
    }
    entry.subscribers.clear();
    currentBytes -= entry.sizeBytes;
    try {
      unlinkSync(entry.filePath);
    } catch {
      // File may already be gone
    }
    entries.delete(id);
  }
}

function evictForCapacity(incomingBytes: number): void {
  while (currentBytes + incomingBytes > MAX_STORE_BYTES && entries.size > 0) {
    // Evict oldest completed entry first; fall back to oldest overall
    let oldestCompleted: string | null = null;
    let oldestAny: string | null = null;
    for (const [id, e] of entries) {
      if (!oldestAny) oldestAny = id;
      if (e.complete && !oldestCompleted) {
        oldestCompleted = id;
        break;
      }
    }
    const victim = oldestCompleted ?? oldestAny;
    if (victim) removeEntry(victim);
    else break;
  }
}

function evictExpired(): void {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (now > entry.expiresAt) removeEntry(id);
  }
}

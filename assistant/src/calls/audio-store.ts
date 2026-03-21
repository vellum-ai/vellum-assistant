import { randomUUID } from "node:crypto";

interface AudioEntry {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

interface StreamingAudioEntry {
  contentType: string;
  expiresAt: number;
  chunks: Uint8Array[];
  totalBytes: number;
  complete: boolean;
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
}

const store = new Map<string, AudioEntry>();
const streamingStore = new Map<string, StreamingAudioEntry>();
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
  const contentType = contentTypeForFormat(format);
  store.set(id, { buffer, contentType, expiresAt: Date.now() + TTL_MS });
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
  const entry: StreamingAudioEntry = {
    contentType,
    expiresAt: Date.now() + TTL_MS,
    chunks: [],
    totalBytes: 0,
    complete: false,
    subscribers: new Set(),
  };
  streamingStore.set(id, entry);

  return {
    audioId: id,
    push(chunk: Uint8Array) {
      entry.chunks.push(chunk);
      entry.totalBytes += chunk.byteLength;
      for (const controller of entry.subscribers) {
        try {
          controller.enqueue(chunk);
        } catch {
          entry.subscribers.delete(controller);
        }
      }
    },
    finalize() {
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
  | { type: "buffer"; buffer: Buffer; contentType: string }
  | { type: "stream"; stream: ReadableStream<Uint8Array>; contentType: string };

export function getAudio(id: string): AudioResult | null {
  evictExpired();

  // Check streaming store first
  const streamingEntry = streamingStore.get(id);
  if (streamingEntry) {
    if (Date.now() > streamingEntry.expiresAt) {
      streamingStore.delete(id);
      return null;
    }

    if (streamingEntry.complete) {
      // Synthesis finished — serve the complete buffer
      const merged = mergeChunks(streamingEntry.chunks);
      return {
        type: "buffer",
        buffer: Buffer.from(merged),
        contentType: streamingEntry.contentType,
      };
    }

    // Still streaming — return a ReadableStream that replays existing
    // chunks and subscribes for future ones.
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        for (const chunk of streamingEntry.chunks) {
          controller.enqueue(chunk);
        }
        if (streamingEntry.complete) {
          controller.close();
        } else {
          streamingEntry.subscribers.add(controller);
        }
      },
      cancel() {
        streamingEntry.subscribers.delete(ctrl);
      },
    });

    return { type: "stream", stream, contentType: streamingEntry.contentType };
  }

  // Check regular store
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    removeEntry(id);
    return null;
  }
  return { type: "buffer", buffer: entry.buffer, contentType: entry.contentType };
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

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
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
  for (const [id, entry] of streamingStore) {
    if (now > entry.expiresAt) {
      for (const controller of entry.subscribers) {
        try {
          controller.close();
        } catch {
          // noop
        }
      }
      streamingStore.delete(id);
    }
  }
}

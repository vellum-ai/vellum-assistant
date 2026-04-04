import { existsSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";

import {
  cleanupAudioSpool,
  createStreamingEntry,
  getAudio,
  storeAudio,
} from "./audio-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuffer(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes, 0x42);
}

function readFileResult(
  result: NonNullable<ReturnType<typeof getAudio>>,
): Buffer {
  if (result.type !== "file")
    throw new Error(`Expected file result, got ${result.type}`);
  return readFileSync(result.filePath);
}

afterAll(() => {
  cleanupAudioSpool();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audio-store", () => {
  describe("storeAudio / getAudio", () => {
    test("stores and retrieves audio by id", () => {
      const buf = makeBuffer(1024);
      const id = storeAudio(buf, "mp3");
      const result = getAudio(id);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("file");
      expect(readFileResult(result!)).toEqual(buf);
      expect(result!.contentType).toBe("audio/mpeg");
    });

    test("returns correct content type for each format", () => {
      const buf = makeBuffer(64);

      const mp3Id = storeAudio(buf, "mp3");
      expect(getAudio(mp3Id)!.contentType).toBe("audio/mpeg");

      const wavId = storeAudio(buf, "wav");
      expect(getAudio(wavId)!.contentType).toBe("audio/wav");

      const opusId = storeAudio(buf, "opus");
      expect(getAudio(opusId)!.contentType).toBe("audio/opus");
    });

    test("returns null for unknown id", () => {
      expect(getAudio("nonexistent-id")).toBeNull();
    });
  });

  describe("TTL expiration", () => {
    test("expired entries return null and delete temp file", () => {
      const buf = makeBuffer(128);
      const id = storeAudio(buf, "wav");
      const filePath =
        getAudio(id)!.type === "file" ? (getAudio(id) as any).filePath : null;
      expect(filePath).toBeTruthy();

      const originalNow = Date.now;
      Date.now = () => originalNow() + 61_000;
      try {
        const result = getAudio(id);
        expect(result).toBeNull();
        // Temp file should be cleaned up
        expect(existsSync(filePath!)).toBe(false);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("capacity eviction", () => {
    test("evicts oldest entries when capacity is exceeded", () => {
      const chunkSize = 10 * 1024 * 1024; // 10MB per chunk
      const ids: string[] = [];

      // Store 5 x 10MB = 50MB (at capacity)
      for (let i = 0; i < 5; i++) {
        ids.push(storeAudio(makeBuffer(chunkSize), "opus"));
      }

      for (const id of ids) {
        expect(getAudio(id)).not.toBeNull();
      }

      // Add one more 10MB entry — should evict the oldest
      const newId = storeAudio(makeBuffer(chunkSize), "mp3");
      expect(getAudio(newId)).not.toBeNull();
      expect(getAudio(ids[0]!)).toBeNull();
    });
  });

  describe("streaming entries", () => {
    test("streaming entries count toward the same byte cap as stored audio", () => {
      const handle = createStreamingEntry("mp3");
      const chunk = makeBuffer(10 * 1024 * 1024); // 10MB

      // Push 40MB of streaming data
      for (let i = 0; i < 4; i++) {
        handle.push(new Uint8Array(chunk));
      }
      handle.finalize();

      // Store another 10MB — should fit at 50MB total
      const storedId = storeAudio(makeBuffer(10 * 1024 * 1024), "wav");
      expect(getAudio(storedId)).not.toBeNull();

      // One more should trigger eviction
      const extraId = storeAudio(makeBuffer(10 * 1024 * 1024), "mp3");
      expect(getAudio(extraId)).not.toBeNull();
      // The streaming entry or the stored entry should have been evicted
      const streamResult = getAudio(handle.audioId);
      const storedResult = getAudio(storedId);
      // At least one was evicted to make room
      expect(!streamResult || !storedResult).toBe(true);
    });

    test("completed streaming audio can be fetched as a file", () => {
      const handle = createStreamingEntry("opus");
      const chunk1 = new Uint8Array([1, 2, 3]);
      const chunk2 = new Uint8Array([4, 5, 6]);
      handle.push(chunk1);
      handle.push(chunk2);
      handle.finalize();

      const result = getAudio(handle.audioId);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("file");
      const content = readFileResult(result!);
      expect(new Uint8Array(content)).toEqual(
        new Uint8Array([1, 2, 3, 4, 5, 6]),
      );
      expect(result!.contentType).toBe("audio/opus");
    });

    test("in-progress streaming returns a ReadableStream", async () => {
      const handle = createStreamingEntry("mp3");
      handle.push(new Uint8Array([10, 20]));

      const result = getAudio(handle.audioId);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stream");

      if (result!.type === "stream") {
        const reader = result!.stream.getReader();

        // Read the replayed existing bytes
        const { value: first } = await reader.read();
        expect(first).toEqual(new Uint8Array([10, 20]));

        // Push more while reading
        handle.push(new Uint8Array([30, 40]));
        const { value: second } = await reader.read();
        expect(second).toEqual(new Uint8Array([30, 40]));

        handle.finalize();
        const { done } = await reader.read();
        expect(done).toBe(true);
      }
    });

    test("oversized or abandoned streams are evicted on expiry", () => {
      const handle = createStreamingEntry("wav");
      handle.push(new Uint8Array(makeBuffer(1024)));
      // Don't finalize — simulate abandoned stream

      // Confirm it exists before expiry
      expect(getAudio(handle.audioId)).not.toBeNull();

      const originalNow = Date.now;
      Date.now = () => originalNow() + 61_000;
      try {
        // Any eviction-triggering call should clean it up
        expect(getAudio(handle.audioId)).toBeNull();
      } finally {
        Date.now = originalNow;
      }
    });
  });
});

import { describe, expect, test } from "bun:test";
import { getAudio, storeAudio } from "./audio-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset module-level state between tests by re-importing.
 * Since the store uses module-level variables, we isolate via fresh imports
 * where needed, but for most tests the shared module state is fine as long
 * as we account for it.
 */

function makeBuffer(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes, 0x42);
}

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
      expect(result!.buffer).toEqual(buf);
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
    test("expired entries return null", () => {
      const buf = makeBuffer(128);
      const id = storeAudio(buf, "wav");

      // Fast-forward time past TTL (60s)
      const originalNow = Date.now;
      Date.now = () => originalNow() + 61_000;
      try {
        const result = getAudio(id);
        expect(result).toBeNull();
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("capacity eviction", () => {
    test("evicts oldest entries when capacity is exceeded", () => {
      // The store has a 50MB cap. Fill it with entries, then add one more
      // that would exceed the cap. The oldest should be evicted.
      const chunkSize = 10 * 1024 * 1024; // 10MB per chunk
      const ids: string[] = [];

      // Store 5 x 10MB = 50MB (at capacity)
      for (let i = 0; i < 5; i++) {
        ids.push(storeAudio(makeBuffer(chunkSize), "opus"));
      }

      // All 5 should be retrievable
      for (const id of ids) {
        expect(getAudio(id)).not.toBeNull();
      }

      // Add one more 10MB entry — should evict the oldest
      const newId = storeAudio(makeBuffer(chunkSize), "mp3");
      expect(getAudio(newId)).not.toBeNull();
      // The first entry should have been evicted
      expect(getAudio(ids[0]!)).toBeNull();
    });
  });
});

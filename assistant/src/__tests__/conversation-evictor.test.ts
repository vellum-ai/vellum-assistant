import { beforeEach, describe, expect, test } from "bun:test";

import {
  ConversationEvictor,
  type EvictableConversation,
} from "../daemon/conversation-evictor.js";

function createMockSession(
  processing = false,
): EvictableConversation & { disposed: boolean } {
  return {
    disposed: false,
    isProcessing() {
      return processing;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

describe("ConversationEvictor", () => {
  let sessions: Map<string, EvictableConversation & { disposed: boolean }>;
  let evictor: ConversationEvictor;

  beforeEach(() => {
    sessions = new Map();
    evictor = new ConversationEvictor(
      sessions as Map<string, EvictableConversation>,
      {
        ttlMs: 1000,
        maxSessions: 3,
        memoryThresholdBytes: Number.MAX_SAFE_INTEGER, // disable memory pressure for most tests
        sweepIntervalMs: 60_000,
      },
    );
  });

  describe("TTL eviction", () => {
    test("evicts sessions that have exceeded TTL", () => {
      const s1 = createMockSession();
      const s2 = createMockSession();
      sessions.set("a", s1);
      sessions.set("b", s2);

      // Touch both, then backdate one beyond TTL
      evictor.touch("a");
      evictor.touch("b");

      // Simulate time passing — set last access to 2 seconds ago (TTL is 1s)
      (
        evictor as unknown as { lastAccess: Map<string, number> }
      ).lastAccess.set("a", Date.now() - 2000);

      const result = evictor.sweep();

      expect(result.ttlEvicted).toBe(1);
      expect(sessions.has("a")).toBe(false);
      expect(sessions.has("b")).toBe(true);
      expect(s1.disposed).toBe(true);
      expect(s2.disposed).toBe(false);
    });

    test("evicts sessions that were never touched (lastAccess = 0)", () => {
      const s1 = createMockSession();
      sessions.set("a", s1);
      // Never call evictor.touch('a')

      const result = evictor.sweep();

      expect(result.ttlEvicted).toBe(1);
      expect(sessions.has("a")).toBe(false);
      expect(s1.disposed).toBe(true);
    });

    test("skips processing sessions", () => {
      const s1 = createMockSession(true); // processing
      sessions.set("a", s1);

      const result = evictor.sweep();

      expect(result.ttlEvicted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(sessions.has("a")).toBe(true);
      expect(s1.disposed).toBe(false);
    });
  });

  describe("LRU eviction", () => {
    test("evicts least-recently-used sessions when over maxSessions", () => {
      // maxSessions = 3, add 5 sessions
      const allSessions: Array<EvictableConversation & { disposed: boolean }> =
        [];
      for (let i = 0; i < 5; i++) {
        const s = createMockSession();
        sessions.set(`s${i}`, s);
        allSessions.push(s);
        evictor.touch(`s${i}`);
      }

      // Make s0 and s1 the oldest, keep s2-s4 fresh
      const now = Date.now();
      const lastAccess = (
        evictor as unknown as { lastAccess: Map<string, number> }
      ).lastAccess;
      lastAccess.set("s0", now - 100); // oldest
      lastAccess.set("s1", now - 90); // second oldest
      // s2, s3, s4 remain at ~now (within TTL)

      const result = evictor.sweep();

      expect(result.lruEvicted).toBe(2); // need to remove 2 to get from 5 to 3
      expect(sessions.size).toBe(3);
      expect(sessions.has("s0")).toBe(false);
      expect(sessions.has("s1")).toBe(false);
      expect(sessions.has("s2")).toBe(true);
      expect(sessions.has("s3")).toBe(true);
      expect(sessions.has("s4")).toBe(true);
    });

    test("skips processing sessions during LRU eviction", () => {
      // maxSessions = 3, add 4 sessions, one processing
      const s0 = createMockSession(true); // processing — should not be evicted
      const s1 = createMockSession();
      const s2 = createMockSession();
      const s3 = createMockSession();
      sessions.set("s0", s0);
      sessions.set("s1", s1);
      sessions.set("s2", s2);
      sessions.set("s3", s3);

      const now = Date.now();
      const lastAccess = (
        evictor as unknown as { lastAccess: Map<string, number> }
      ).lastAccess;
      lastAccess.set("s0", now - 50); // old but processing
      lastAccess.set("s1", now - 40);
      lastAccess.set("s2", now);
      lastAccess.set("s3", now);

      const result = evictor.sweep();

      // s1 is the LRU non-processing session, gets evicted
      expect(result.lruEvicted).toBe(1);
      expect(sessions.has("s0")).toBe(true); // kept: processing
      expect(sessions.has("s1")).toBe(false); // evicted: LRU
      expect(s0.disposed).toBe(false);
      expect(s1.disposed).toBe(true);
    });
  });

  describe("onEvict callback", () => {
    test("calls onEvict for each evicted session", () => {
      const evicted: string[] = [];
      evictor.onEvict = (id) => evicted.push(id);

      const s1 = createMockSession();
      sessions.set("a", s1);
      // Never touched — will be TTL evicted

      evictor.sweep();

      expect(evicted).toEqual(["a"]);
    });
  });

  describe("remove()", () => {
    test("cleans up tracking for externally removed sessions", () => {
      const s1 = createMockSession();
      sessions.set("a", s1);
      evictor.touch("a");

      expect(evictor.trackedCount).toBe(1);

      evictor.remove("a");
      expect(evictor.trackedCount).toBe(0);
    });
  });

  describe("stale lastAccess cleanup", () => {
    test("removes lastAccess entries for sessions no longer in the map", () => {
      const s1 = createMockSession();
      sessions.set("a", s1);
      evictor.touch("a");
      evictor.touch("phantom"); // tracked but no session in map

      expect(evictor.trackedCount).toBe(2);

      // Backdate 'a' so it's evicted by TTL, 'phantom' cleaned by stale check
      (
        evictor as unknown as { lastAccess: Map<string, number> }
      ).lastAccess.set("a", Date.now() - 2000);

      evictor.sweep();

      expect(evictor.trackedCount).toBe(0);
    });
  });

  describe("start/stop", () => {
    test("stop clears tracking state", () => {
      evictor.touch("a");
      evictor.touch("b");
      expect(evictor.trackedCount).toBe(2);

      evictor.stop();
      expect(evictor.trackedCount).toBe(0);
    });
  });
});

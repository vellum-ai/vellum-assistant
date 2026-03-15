/**
 * Tests for CES grant stores.
 *
 * Covers:
 * - Persistent store: initialization, duplicate prevention by canonical grant
 *   hash, fail-closed behavior on corrupt/unreadable files.
 * - Temporary store: allow_once consumption, allow_10m expiry, allow_thread
 *   scoping by conversation ID, clearConversation cleanup.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { PersistentGrantStore, type PersistentGrant } from "../grants/persistent-store.js";
import { TemporaryGrantStore } from "../grants/temporary-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ces-grant-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeGrant(overrides?: Partial<PersistentGrant>): PersistentGrant {
  return {
    id: overrides?.id ?? randomUUID(),
    tool: overrides?.tool ?? "host_bash",
    pattern: overrides?.pattern ?? "npm install",
    scope: overrides?.scope ?? "/project",
    createdAt: overrides?.createdAt ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Persistent store
// ---------------------------------------------------------------------------

describe("PersistentGrantStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    test("creates grants.json when file does not exist", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      const filePath = join(tmpDir, "grants.json");
      expect(existsSync(filePath)).toBe(true);

      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(data.version).toBe(1);
      expect(data.grants).toEqual([]);
    });

    test("creates parent directory if missing", () => {
      const nestedDir = join(tmpDir, "nested", "grants");
      const store = new PersistentGrantStore(nestedDir);
      store.init();

      expect(existsSync(join(nestedDir, "grants.json"))).toBe(true);
    });

    test("loads existing valid grants file", () => {
      const grant = makeGrant();
      writeFileSync(
        join(tmpDir, "grants.json"),
        JSON.stringify({ version: 1, grants: [grant] }, null, 2),
      );

      const store = new PersistentGrantStore(tmpDir);
      store.init();

      const grants = store.getAll();
      expect(grants).toHaveLength(1);
      expect(grants[0].id).toBe(grant.id);
    });
  });

  describe("add and deduplication", () => {
    test("adds a new grant and persists it", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      const grant = makeGrant();
      const added = store.add(grant);
      expect(added).toBe(true);

      // Verify persisted by creating a new store instance
      const store2 = new PersistentGrantStore(tmpDir);
      const grants = store2.getAll();
      expect(grants).toHaveLength(1);
      expect(grants[0].id).toBe(grant.id);
    });

    test("deduplicates by canonical grant id", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      const grant = makeGrant({ id: "canonical-hash-123" });
      expect(store.add(grant)).toBe(true);
      expect(store.add(grant)).toBe(false); // duplicate

      expect(store.getAll()).toHaveLength(1);
    });

    test("allows grants with different IDs", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      store.add(makeGrant({ id: "grant-a" }));
      store.add(makeGrant({ id: "grant-b" }));

      expect(store.getAll()).toHaveLength(2);
    });
  });

  describe("getById and has", () => {
    test("returns grant by ID", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      const grant = makeGrant({ id: "lookup-id" });
      store.add(grant);

      expect(store.getById("lookup-id")).toBeDefined();
      expect(store.getById("lookup-id")!.tool).toBe(grant.tool);
    });

    test("returns undefined for missing ID", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      expect(store.getById("nonexistent")).toBeUndefined();
    });

    test("has() returns true for existing grant", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      store.add(makeGrant({ id: "exists" }));
      expect(store.has("exists")).toBe(true);
      expect(store.has("missing")).toBe(false);
    });
  });

  describe("remove", () => {
    test("removes an existing grant", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      store.add(makeGrant({ id: "to-remove" }));
      expect(store.remove("to-remove")).toBe(true);
      expect(store.has("to-remove")).toBe(false);
    });

    test("returns false for non-existent grant", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      expect(store.remove("nonexistent")).toBe(false);
    });
  });

  describe("clear", () => {
    test("removes all grants", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      store.add(makeGrant({ id: "a" }));
      store.add(makeGrant({ id: "b" }));
      store.clear();

      expect(store.getAll()).toHaveLength(0);
    });
  });

  describe("fail-closed behavior", () => {
    test("throws on malformed JSON", () => {
      writeFileSync(join(tmpDir, "grants.json"), "not json at all");

      const store = new PersistentGrantStore(tmpDir);
      expect(() => store.init()).toThrow();
    });

    test("throws on missing version field", () => {
      writeFileSync(
        join(tmpDir, "grants.json"),
        JSON.stringify({ grants: [] }),
      );

      const store = new PersistentGrantStore(tmpDir);
      expect(() => store.init()).toThrow(/malformed/i);
    });

    test("throws on missing grants field", () => {
      writeFileSync(
        join(tmpDir, "grants.json"),
        JSON.stringify({ version: 1 }),
      );

      const store = new PersistentGrantStore(tmpDir);
      expect(() => store.init()).toThrow(/malformed/i);
    });

    test("throws on unsupported version", () => {
      writeFileSync(
        join(tmpDir, "grants.json"),
        JSON.stringify({ version: 999, grants: [] }),
      );

      const store = new PersistentGrantStore(tmpDir);
      expect(() => store.init()).toThrow(/unsupported version/i);
    });

    test("blocks all operations after corruption is detected", () => {
      writeFileSync(join(tmpDir, "grants.json"), "corrupt");

      const store = new PersistentGrantStore(tmpDir);
      expect(() => store.init()).toThrow();

      // Subsequent operations should also fail
      expect(() => store.getAll()).toThrow(/corrupt/i);
      expect(() => store.add(makeGrant())).toThrow(/corrupt/i);
      expect(() => store.remove("any")).toThrow(/corrupt/i);
      expect(() => store.clear()).toThrow(/corrupt/i);
    });

    test("throws on grants field being non-array", () => {
      writeFileSync(
        join(tmpDir, "grants.json"),
        JSON.stringify({ version: 1, grants: "not-an-array" }),
      );

      const store = new PersistentGrantStore(tmpDir);
      expect(() => store.init()).toThrow(/not an array/i);
    });
  });

  describe("atomic writes", () => {
    test("grants.json is valid after write", () => {
      const store = new PersistentGrantStore(tmpDir);
      store.init();

      store.add(makeGrant({ id: "atom-1" }));
      store.add(makeGrant({ id: "atom-2" }));

      const raw = readFileSync(join(tmpDir, "grants.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.version).toBe(1);
      expect(data.grants).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Temporary store
// ---------------------------------------------------------------------------

describe("TemporaryGrantStore", () => {
  let store: TemporaryGrantStore;

  beforeEach(() => {
    store = new TemporaryGrantStore();
  });

  describe("allow_once", () => {
    test("grant is consumed on first check", () => {
      store.add("allow_once", "hash-abc");

      expect(store.check("allow_once", "hash-abc")).toBe(true);
      // Second check should fail — consumed
      expect(store.check("allow_once", "hash-abc")).toBe(false);
    });

    test("different proposal hashes are independent", () => {
      store.add("allow_once", "hash-1");
      store.add("allow_once", "hash-2");

      expect(store.check("allow_once", "hash-1")).toBe(true);
      expect(store.check("allow_once", "hash-2")).toBe(true);
      // Both consumed
      expect(store.check("allow_once", "hash-1")).toBe(false);
      expect(store.check("allow_once", "hash-2")).toBe(false);
    });
  });

  describe("allow_10m", () => {
    test("grant is active before expiry", () => {
      store.add("allow_10m", "hash-timed");

      expect(store.check("allow_10m", "hash-timed")).toBe(true);
      // Can be checked multiple times (not consumed)
      expect(store.check("allow_10m", "hash-timed")).toBe(true);
    });

    test("grant expires after TTL", () => {
      // Add with a very short duration (1ms)
      store.add("allow_10m", "hash-expire", { durationMs: 1 });

      // Wait for expiry — use a synchronous busy-wait to avoid flakes
      const start = Date.now();
      while (Date.now() - start < 5) {
        // spin
      }

      expect(store.check("allow_10m", "hash-expire")).toBe(false);
    });

    test("expired grant is lazily purged", () => {
      store.add("allow_10m", "hash-lazy", { durationMs: 1 });

      const start = Date.now();
      while (Date.now() - start < 5) {
        // spin
      }

      // Check triggers lazy purge
      store.check("allow_10m", "hash-lazy");
      expect(store.size).toBe(0);
    });
  });

  describe("allow_thread", () => {
    test("requires conversationId", () => {
      expect(() => store.add("allow_thread", "hash-t", {})).toThrow(
        /conversationId/,
      );
    });

    test("scoped to conversation ID", () => {
      store.add("allow_thread", "hash-t", { conversationId: "conv-1" });

      expect(store.check("allow_thread", "hash-t", "conv-1")).toBe(true);
      // Different conversation should not match
      expect(store.check("allow_thread", "hash-t", "conv-2")).toBe(false);
    });

    test("same proposal hash in different conversations are independent", () => {
      store.add("allow_thread", "hash-t", { conversationId: "conv-a" });
      store.add("allow_thread", "hash-t", { conversationId: "conv-b" });

      expect(store.check("allow_thread", "hash-t", "conv-a")).toBe(true);
      expect(store.check("allow_thread", "hash-t", "conv-b")).toBe(true);
    });

    test("not consumed on check (persists within thread)", () => {
      store.add("allow_thread", "hash-t", { conversationId: "conv-1" });

      expect(store.check("allow_thread", "hash-t", "conv-1")).toBe(true);
      expect(store.check("allow_thread", "hash-t", "conv-1")).toBe(true);
      expect(store.check("allow_thread", "hash-t", "conv-1")).toBe(true);
    });
  });

  describe("checkAny", () => {
    test("finds allow_once grant", () => {
      store.add("allow_once", "hash-any");
      expect(store.checkAny("hash-any")).toBe("allow_once");
      // Consumed — should not match again
      expect(store.checkAny("hash-any")).toBeUndefined();
    });

    test("finds allow_10m grant", () => {
      store.add("allow_10m", "hash-any-t");
      expect(store.checkAny("hash-any-t")).toBe("allow_10m");
    });

    test("finds allow_thread grant with conversationId", () => {
      store.add("allow_thread", "hash-any-th", { conversationId: "conv-x" });
      expect(store.checkAny("hash-any-th", "conv-x")).toBe("allow_thread");
    });

    test("returns undefined when no grants match", () => {
      expect(store.checkAny("no-such-hash")).toBeUndefined();
    });

    test("prefers allow_once over allow_10m", () => {
      store.add("allow_once", "hash-prio");
      store.add("allow_10m", "hash-prio");

      expect(store.checkAny("hash-prio")).toBe("allow_once");
    });
  });

  describe("remove", () => {
    test("removes a specific grant", () => {
      store.add("allow_10m", "hash-rm");
      expect(store.remove("allow_10m", "hash-rm")).toBe(true);
      expect(store.check("allow_10m", "hash-rm")).toBe(false);
    });

    test("returns false for non-existent grant", () => {
      expect(store.remove("allow_once", "nope")).toBe(false);
    });
  });

  describe("clearConversation", () => {
    test("removes all thread grants for a conversation", () => {
      store.add("allow_thread", "hash-1", { conversationId: "conv-clear" });
      store.add("allow_thread", "hash-2", { conversationId: "conv-clear" });
      store.add("allow_thread", "hash-3", { conversationId: "conv-keep" });

      store.clearConversation("conv-clear");

      expect(store.check("allow_thread", "hash-1", "conv-clear")).toBe(false);
      expect(store.check("allow_thread", "hash-2", "conv-clear")).toBe(false);
      // Other conversation unaffected
      expect(store.check("allow_thread", "hash-3", "conv-keep")).toBe(true);
    });

    test("does not affect non-thread grants", () => {
      store.add("allow_once", "hash-non-thread");
      store.add("allow_10m", "hash-non-thread-t");

      store.clearConversation("any-conv");

      // Non-thread grants unaffected
      expect(store.check("allow_once", "hash-non-thread")).toBe(true);
      expect(store.check("allow_10m", "hash-non-thread-t")).toBe(true);
    });
  });

  describe("clear", () => {
    test("removes all grants", () => {
      store.add("allow_once", "h1");
      store.add("allow_10m", "h2");
      store.add("allow_thread", "h3", { conversationId: "c1" });

      store.clear();
      expect(store.size).toBe(0);
    });
  });

  describe("process restart simulation", () => {
    test("grants do not survive new store instance", () => {
      store.add("allow_once", "hash-restart");
      store.add("allow_10m", "hash-restart-t");
      store.add("allow_thread", "hash-restart-th", {
        conversationId: "conv-r",
      });

      // "Restart" — new instance
      const newStore = new TemporaryGrantStore();
      expect(newStore.size).toBe(0);
      expect(newStore.checkAny("hash-restart")).toBeUndefined();
    });
  });
});

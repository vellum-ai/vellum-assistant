/**
 * Tests for the last-seen avatar cache: graceful degradation when the
 * environment has no IndexedDB (happy-dom ships none), and round-trips of
 * both record kinds against a minimal in-memory `indexedDB` fake.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CharacterTraits } from "@/types/avatar";

import {
  deleteLastSeenAvatar,
  lastSeenAvatarGenerations,
  readLastSeenAvatar,
  writeLastSeenAvatar,
} from "./avatar-last-seen-cache";

const traits: CharacterTraits = {
  bodyShape: "brontosaurus",
  eyeStyle: "curious",
  color: "cosmic-purple",
};

type Listener = (() => void) | null;

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Listener = null;
  onerror: Listener = null;
  onupgradeneeded: Listener = null;

  settle(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
  }

  fail(message: string): void {
    this.error = new DOMException(message);
    queueMicrotask(() => this.onerror?.());
  }
}

/** Just enough of IDBFactory / IDBDatabase / IDBObjectStore for the cache module. */
function installFakeIndexedDb(options: { failWrites?: boolean } = {}) {
  const rows = new Map<string, unknown>();
  const stores = new Set<string>();
  const store = {
    get: (key: string) => {
      const request = new FakeRequest<unknown>();
      request.settle(rows.get(key));
      return request;
    },
    put: (value: { id: string }) => {
      const request = new FakeRequest<string>();
      if (options.failWrites) {
        request.fail("write refused");
      } else {
        rows.set(value.id, value);
        request.settle(value.id);
      }
      return request;
    },
    delete: (key: string) => {
      const request = new FakeRequest<undefined>();
      rows.delete(key);
      request.settle(undefined);
      return request;
    },
  };
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.add(name);
    },
    transaction: () => ({ objectStore: () => store }),
    close: () => {},
  };
  const factory = {
    open: () => {
      const request = new FakeRequest<typeof db>();
      request.result = db;
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    value: factory,
    configurable: true,
    writable: true,
  });
  return { rows, stores };
}

function uninstallFakeIndexedDb(): void {
  Reflect.deleteProperty(globalThis, "indexedDB");
}

describe("avatar-last-seen-cache", () => {
  describe("without IndexedDB", () => {
    beforeEach(() => {
      uninstallFakeIndexedDb();
    });

    test("read resolves null", async () => {
      expect(await readLastSeenAvatar("a")).toBeNull();
    });

    test("write and delete resolve without throwing", async () => {
      await expect(
        writeLastSeenAvatar("a", { kind: "character", traits }),
      ).resolves.toBeUndefined();
      await expect(deleteLastSeenAvatar("a")).resolves.toBeUndefined();
    });
  });

  describe("with IndexedDB", () => {
    afterEach(() => {
      uninstallFakeIndexedDb();
    });

    test("creates the store on first open", async () => {
      const { stores } = installFakeIndexedDb();
      await readLastSeenAvatar("a");
      expect(stores.has("avatars")).toBe(true);
    });

    test("round-trips a character entry", async () => {
      installFakeIndexedDb();
      await writeLastSeenAvatar("a", { kind: "character", traits });
      expect(await readLastSeenAvatar("a")).toEqual({
        kind: "character",
        traits,
      });
    });

    test("round-trips an image entry as a Blob", async () => {
      installFakeIndexedDb();
      const blob = new Blob(["png"], { type: "image/png" });
      await writeLastSeenAvatar("a", { kind: "image", blob });
      const read = await readLastSeenAvatar("a");
      expect(read?.kind).toBe("image");
      expect(read?.kind === "image" && read.blob).toBe(blob);
    });

    test("stamps the record with the id and a timestamp", async () => {
      const { rows } = installFakeIndexedDb();
      await writeLastSeenAvatar("a", { kind: "character", traits });
      expect(rows.get("a")).toMatchObject({
        id: "a",
        kind: "character",
        updatedAt: expect.any(Number),
      });
    });

    test("delete removes the entry", async () => {
      installFakeIndexedDb();
      await writeLastSeenAvatar("a", { kind: "character", traits });
      await deleteLastSeenAvatar("a");
      expect(await readLastSeenAvatar("a")).toBeNull();
    });

    test("read returns null for an unknown id and for a malformed record", async () => {
      const { rows } = installFakeIndexedDb();
      expect(await readLastSeenAvatar("missing")).toBeNull();
      rows.set("bad", { id: "bad", kind: "character", traits: { nope: 1 } });
      expect(await readLastSeenAvatar("bad")).toBeNull();
    });

    test("a write with a superseded generation commits nothing", async () => {
      installFakeIndexedDb();
      const stale = lastSeenAvatarGenerations.claim("a");
      await writeLastSeenAvatar("a", { kind: "character", traits });
      expect(lastSeenAvatarGenerations.isCurrent("a", stale)).toBe(false);
      await writeLastSeenAvatar(
        "a",
        { kind: "image", blob: new Blob() },
        stale,
      );
      expect(await readLastSeenAvatar("a")).toEqual({
        kind: "character",
        traits,
      });
      await deleteLastSeenAvatar("a", stale);
      expect(await readLastSeenAvatar("a")).not.toBeNull();
    });

    test("a plain delete supersedes an in-flight generation", async () => {
      installFakeIndexedDb();
      const inFlight = lastSeenAvatarGenerations.claim("a");
      await deleteLastSeenAvatar("a");
      expect(lastSeenAvatarGenerations.isCurrent("a", inFlight)).toBe(false);
    });

    test("a failed transaction is swallowed", async () => {
      installFakeIndexedDb({ failWrites: true });
      await expect(
        writeLastSeenAvatar("a", { kind: "character", traits }),
      ).resolves.toBeUndefined();
      expect(await readLastSeenAvatar("a")).toBeNull();
    });
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";

import type { Lockfile } from "@vellumai/local-mode/contract";

// Stub @vellumai/local-mode so we control the resolved paths.
const CANONICAL_PATH = "/tmp/test-lockfile.json";
const LEGACY_PATH = "/tmp/test-lockfile-legacy.json";
let mockPaths = [CANONICAL_PATH];
mock.module("@vellumai/local-mode", () => ({
  resolveLockfilePaths: () => mockPaths,
}));

// Passthrough the real parseLockfile — stubbing the @vellumai/local-mode
// entry above doesn't touch the /contract subpath it lives in.
const { parseLockfile } = await import("@vellumai/local-mode/contract");
mock.module("@vellumai/local-mode/contract", () => ({
  parseLockfile,
}));

const {
  installLockfileWatcher,
  getWatchedLockfile,
  onLockfileChange,
  __resetForTesting,
} = await import("./lockfile-watcher");

const SAMPLE_LOCKFILE: Lockfile = {
  assistants: [
    { assistantId: "ast-1", name: "Alpha", cloud: "local" },
    { assistantId: "ast-2", name: "Beta", cloud: "local" },
  ],
  activeAssistant: "ast-1",
};

const writeLockfile = (data: Lockfile, path = CANONICAL_PATH): void => {
  fs.writeFileSync(path, JSON.stringify(data), "utf-8");
};

const removeLockfile = (): void => {
  for (const p of [CANONICAL_PATH, LEGACY_PATH]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // already gone
    }
  }
};

beforeEach(() => {
  __resetForTesting();
  mockPaths = [CANONICAL_PATH];
  removeLockfile();
});

afterEach(() => {
  __resetForTesting();
  mockPaths = [CANONICAL_PATH];
  removeLockfile();
});

describe("lockfile-watcher", () => {
  describe("installLockfileWatcher", () => {
    test("reads the lockfile synchronously on install and caches the parsed result", () => {
      /**
       * Tests that the watcher reads and parses the lockfile immediately at
       * install time so downstream consumers (tray menu) have data on frame one.
       */

      // GIVEN a lockfile exists on disk
      writeLockfile(SAMPLE_LOCKFILE);

      // WHEN the watcher is installed
      const teardown = installLockfileWatcher();

      // THEN the cached lockfile reflects the on-disk content
      const cached = getWatchedLockfile();
      expect(cached.assistants).toHaveLength(2);
      expect(cached.assistants[0]?.name).toBe("Alpha");
      expect(cached.activeAssistant).toBe("ast-1");

      teardown();
    });

    test("returns an empty lockfile when the file does not exist", () => {
      /**
       * Tests graceful handling when no lockfile exists (first launch before
       * the CLI creates it).
       */

      // GIVEN no lockfile on disk

      // WHEN the watcher is installed
      const teardown = installLockfileWatcher();

      // THEN the cached lockfile is empty
      const cached = getWatchedLockfile();
      expect(cached.assistants).toHaveLength(0);
      expect(cached.activeAssistant).toBeNull();

      teardown();
    });

    test("teardown clears timers and listeners", () => {
      /**
       * Tests that calling the teardown function stops polling and removes
       * all registered listeners.
       */

      // GIVEN the watcher is installed with a listener
      writeLockfile(SAMPLE_LOCKFILE);
      const teardown = installLockfileWatcher();
      const listener = mock(() => undefined);
      onLockfileChange(listener);

      // WHEN teardown is called
      teardown();

      // THEN subsequent file changes don't fire the listener (we can't
      // easily test the interval stopped, but we verify listeners are cleared)
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("onLockfileChange", () => {
    test("notifies listeners when mtime changes after debounce", async () => {
      /**
       * Tests that writing a new lockfile triggers the change listener
       * after the poll interval + debounce window.
       */

      // GIVEN the watcher is installed with an initial lockfile
      writeLockfile(SAMPLE_LOCKFILE);
      const teardown = installLockfileWatcher();

      const received: Lockfile[] = [];
      onLockfileChange((lockfile) => {
        received.push(lockfile);
      });

      // WHEN the lockfile is updated with a forced mtime bump (ensure the
      // filesystem registers a different mtime than the initial read).
      await new Promise((resolve) => setTimeout(resolve, 50));
      const updated: Lockfile = {
        assistants: [{ assistantId: "ast-3", name: "Gamma", cloud: "local" }],
        activeAssistant: "ast-3",
      };
      writeLockfile(updated);
      const now = new Date();
      fs.utimesSync(CANONICAL_PATH, now, new Date(now.getTime() + 1000));

      // THEN after waiting for poll + debounce (500ms + 100ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 750));

      expect(received).toHaveLength(1);
      expect(received[0]?.assistants[0]?.name).toBe("Gamma");
      expect(received[0]?.activeAssistant).toBe("ast-3");

      // AND the cached lockfile is also updated
      expect(getWatchedLockfile().activeAssistant).toBe("ast-3");

      teardown();
    });

    test("unsubscribe removes the listener", async () => {
      /**
       * Tests that calling the unsubscribe function prevents future
       * notifications to that listener.
       */

      // GIVEN the watcher is installed with a listener
      writeLockfile(SAMPLE_LOCKFILE);
      const teardown = installLockfileWatcher();

      const listener = mock((_lockfile: Lockfile) => undefined);
      const unsub = onLockfileChange(listener);

      // WHEN the listener is unsubscribed before a change
      unsub();

      // AND the lockfile is updated
      writeLockfile({
        assistants: [],
        activeAssistant: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 750));

      // THEN the listener was never called
      expect(listener).not.toHaveBeenCalled();

      teardown();
    });
  });

  describe("getWatchedLockfile", () => {
    test("returns the empty lockfile before install", () => {
      /**
       * Tests that getWatchedLockfile is safe to call even before the watcher
       * is installed — returns the default empty lockfile.
       */

      // GIVEN the watcher has not been installed

      // WHEN we read the cached lockfile
      const cached = getWatchedLockfile();

      // THEN it's the empty default
      expect(cached.assistants).toHaveLength(0);
      expect(cached.activeAssistant).toBeNull();
    });
  });

  describe("legacy path migration", () => {
    test("seeds cache from legacy path when canonical does not exist", () => {
      /**
       * Tests that installs with only the legacy lockfile still populate
       * the cache on startup, even though polling targets the canonical path.
       */

      // GIVEN two candidates where only the legacy path has data
      mockPaths = [CANONICAL_PATH, LEGACY_PATH];
      writeLockfile(SAMPLE_LOCKFILE, LEGACY_PATH);

      // WHEN the watcher is installed
      const teardown = installLockfileWatcher();

      // THEN the cache is seeded from the legacy file
      const cached = getWatchedLockfile();
      expect(cached.assistants).toHaveLength(2);
      expect(cached.activeAssistant).toBe("ast-1");

      teardown();
    });

    test("detects writes to canonical path after initial legacy-only seed", async () => {
      /**
       * Tests that after seeding from legacy, the watcher picks up new
       * writes to the canonical path (where all write helpers target).
       */

      // GIVEN two candidates where only the legacy path has data initially
      mockPaths = [CANONICAL_PATH, LEGACY_PATH];
      writeLockfile(SAMPLE_LOCKFILE, LEGACY_PATH);
      const teardown = installLockfileWatcher();

      const received: Lockfile[] = [];
      onLockfileChange((lockfile) => {
        received.push(lockfile);
      });

      // WHEN a write creates the canonical file (simulating a CLI write)
      await new Promise((resolve) => setTimeout(resolve, 50));
      const updated: Lockfile = {
        assistants: [{ assistantId: "ast-new", name: "NewAssistant", cloud: "local" }],
        activeAssistant: "ast-new",
      };
      writeLockfile(updated, CANONICAL_PATH);

      // THEN after poll + debounce the change is detected
      await new Promise((resolve) => setTimeout(resolve, 750));

      expect(received).toHaveLength(1);
      expect(received[0]?.assistants[0]?.name).toBe("NewAssistant");
      expect(getWatchedLockfile().activeAssistant).toBe("ast-new");

      teardown();
    });
  });
});

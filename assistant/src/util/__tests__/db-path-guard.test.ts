import { describe, expect, test } from "bun:test";

import {
  assertNotLiveDbInTests,
  isBunTestRunner,
  LIVE_DB_PATH_SANDBOX,
} from "../db-path-guard.js";

describe("db-path-guard", () => {
  describe("isBunTestRunner", () => {
    test("returns true when running under bun test", () => {
      // We ARE in a bun test runner right now — Bun.main is this file.
      expect(isBunTestRunner()).toBe(true);
    });
  });

  describe("assertNotLiveDbInTests", () => {
    test("throws when resolvedPath equals the canonical sandbox live DB path", () => {
      expect(() => assertNotLiveDbInTests(LIVE_DB_PATH_SANDBOX)).toThrow(
        /Refusing to resolve getDbPath\(\) to the live production DB/,
      );
    });

    test("error message names the offending path and the env var", () => {
      try {
        assertNotLiveDbInTests(LIVE_DB_PATH_SANDBOX);
        throw new Error("guard should have thrown");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toContain(LIVE_DB_PATH_SANDBOX);
        expect(message).toContain("VELLUM_WORKSPACE_DIR=");
        expect(message).toContain("Bun.main=");
        expect(message).toContain(
          "/workspace/journal/2026-05-25-db-ghost-3-recovery.md",
        );
      }
    });

    test("does NOT throw for a temp-dir path", () => {
      expect(() =>
        assertNotLiveDbInTests(
          "/tmp/vellum-test-workspace-abc/data/db/assistant.db",
        ),
      ).not.toThrow();
    });

    test("does NOT throw for an unrelated path", () => {
      expect(() =>
        assertNotLiveDbInTests("/some/other/path/to/anything.db"),
      ).not.toThrow();
    });

    test("does NOT throw for the developer-machine homedir DB path", () => {
      // Dev-machine paths are intentionally out of scope for this guard.
      // The sandbox path is the primary blast radius.
      expect(() =>
        assertNotLiveDbInTests(
          "/Users/dev/.vellum/workspace/data/db/assistant.db",
        ),
      ).not.toThrow();
    });

    test("does NOT throw for a path that contains but does not equal the sandbox path", () => {
      expect(() =>
        assertNotLiveDbInTests("/workspace/data/db/assistant.db.bak"),
      ).not.toThrow();
      expect(() =>
        assertNotLiveDbInTests("/prefix/workspace/data/db/assistant.db"),
      ).not.toThrow();
    });
  });
});

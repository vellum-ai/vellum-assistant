import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  assertTestWorkspaceIsTempDir,
  isBunTestRunner,
} from "../test-workspace-guard.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

describe("test-workspace-guard", () => {
  describe("isBunTestRunner", () => {
    test("returns true when running under bun test", () => {
      expect(isBunTestRunner()).toBe(true);
    });
  });

  describe("assertTestWorkspaceIsTempDir", () => {
    test("throws when VELLUM_WORKSPACE_DIR is /workspace", () => {
      process.env.VELLUM_WORKSPACE_DIR = "/workspace";
      expect(() => assertTestWorkspaceIsTempDir()).toThrow(
        /Refusing to use VELLUM_WORKSPACE_DIR=\/workspace/,
      );
    });

    test("throws when VELLUM_WORKSPACE_DIR is any non-tmp path", () => {
      process.env.VELLUM_WORKSPACE_DIR = "/etc/something";
      expect(() => assertTestWorkspaceIsTempDir()).toThrow(
        /must be a path under the system temp directory/,
      );
    });

    test("error message names the offending workspace dir, the tmp prefix, and the preload file", () => {
      process.env.VELLUM_WORKSPACE_DIR = "/workspace";
      try {
        assertTestWorkspaceIsTempDir();
        throw new Error("guard should have thrown");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toContain("VELLUM_WORKSPACE_DIR=/workspace");
        expect(message).toContain(realpathSync(tmpdir()));
        expect(message).toContain(
          "assistant/src/__tests__/test-preload.ts",
        );
      }
    });

    test("does NOT throw when VELLUM_WORKSPACE_DIR is a path under tmpdir()", () => {
      const tmpRealpath = realpathSync(tmpdir());
      process.env.VELLUM_WORKSPACE_DIR = `${tmpRealpath}/vellum-test-workspace-abc`;
      expect(() => assertTestWorkspaceIsTempDir()).not.toThrow();
    });

    test("does NOT throw when VELLUM_WORKSPACE_DIR equals tmpdir() exactly", () => {
      process.env.VELLUM_WORKSPACE_DIR = realpathSync(tmpdir());
      expect(() => assertTestWorkspaceIsTempDir()).not.toThrow();
    });

    test("does NOT throw when VELLUM_WORKSPACE_DIR is unset", () => {
      // Home-directory fallback path is harmless — the daemon never writes
      // to /workspace via that branch.
      delete process.env.VELLUM_WORKSPACE_DIR;
      expect(() => assertTestWorkspaceIsTempDir()).not.toThrow();
    });

    test("does NOT throw for a path that contains but does not equal the tmp prefix", () => {
      // String-prefix match must require a trailing slash to avoid false
      // positives like /tmpx/... when tmpdir is /tmp.
      const tmpRealpath = realpathSync(tmpdir());
      process.env.VELLUM_WORKSPACE_DIR = `${tmpRealpath}x/not-actually-tmp`;
      expect(() => assertTestWorkspaceIsTempDir()).toThrow();
    });
  });

  describe("integration with getWorkspaceDir", () => {
    // The guard fires inside getWorkspaceDir() and therefore inside every
    // downstream helper (getDbPath, getConversationsDir, getProtectedDir, …).
    // Re-import platform.ts dynamically so we hit the actual call path.

    let getWorkspaceDir: () => string;
    let getDbPath: () => string;

    beforeEach(async () => {
      const platform = await import("../platform.js");
      getWorkspaceDir = platform.getWorkspaceDir;
      getDbPath = platform.getDbPath;
    });

    test("getWorkspaceDir() throws when VELLUM_WORKSPACE_DIR is /workspace", () => {
      process.env.VELLUM_WORKSPACE_DIR = "/workspace";
      expect(() => getWorkspaceDir()).toThrow(
        /Refusing to use VELLUM_WORKSPACE_DIR/,
      );
    });

    test("getDbPath() throws transitively when VELLUM_WORKSPACE_DIR is /workspace", () => {
      process.env.VELLUM_WORKSPACE_DIR = "/workspace";
      expect(() => getDbPath()).toThrow(
        /Refusing to use VELLUM_WORKSPACE_DIR/,
      );
    });

    test("getDbPath() returns successfully when workspace dir is under tmp", () => {
      const tmpRealpath = realpathSync(tmpdir());
      process.env.VELLUM_WORKSPACE_DIR = `${tmpRealpath}/vellum-test-workspace-abc`;
      expect(getDbPath()).toBe(
        `${tmpRealpath}/vellum-test-workspace-abc/data/db/assistant.db`,
      );
    });
  });
});

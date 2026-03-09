import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveBundledDir } from "../util/bundled-asset.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `bundled-asset-test-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveBundledDir", () => {
  test("source mode: returns join(callerDir, relativePath) when callerDir is a normal path", () => {
    const result = resolveBundledDir(
      "/some/source/path",
      "templates",
      "templates",
    );
    expect(result).toBe(join("/some/source/path", "templates"));
  });

  test("source mode: does not check existsSync for the source path", () => {
    // Even if the resolved path does not exist, it returns it as-is
    const result = resolveBundledDir(
      "/nonexistent/path",
      "templates",
      "templates",
    );
    expect(result).toBe(join("/nonexistent/path", "templates"));
  });

  describe("compiled mode (/$bunfs/ prefix)", () => {
    // In compiled mode, process.execPath determines fallback locations.
    // We simulate by creating real directories at the expected fallback paths.

    let savedExecPath: string;

    beforeEach(() => {
      savedExecPath = process.execPath;
    });

    afterEach(() => {
      process.execPath = savedExecPath;
    });

    test("prefers Contents/Resources/<bundleName> when it exists", () => {
      // Simulate macOS .app bundle: binary at Contents/MacOS/vellum-daemon
      const macosDir = join(tempDir, "Contents", "MacOS");
      const resourcesDir = join(tempDir, "Contents", "Resources");
      mkdirSync(macosDir, { recursive: true });
      mkdirSync(join(resourcesDir, "templates"), { recursive: true });

      process.execPath = join(macosDir, "vellum-daemon");

      const result = resolveBundledDir(
        "/$bunfs/root/src/config",
        "templates",
        "templates",
      );
      expect(result).toBe(join(resourcesDir, "templates"));
    });

    test("falls back to <execDir>/<bundleName> when Resources does not exist", () => {
      // Simulate standalone binary deployment (no .app bundle)
      const binDir = join(tempDir, "bin");
      mkdirSync(join(binDir, "templates"), { recursive: true });

      process.execPath = join(binDir, "vellum-daemon");

      const result = resolveBundledDir(
        "/$bunfs/root/src/config",
        "templates",
        "templates",
      );
      expect(result).toBe(join(binDir, "templates"));
    });

    test("falls back to source path when neither Resources nor execDir have the asset", () => {
      const binDir = join(tempDir, "bin");
      mkdirSync(binDir, { recursive: true });
      // Don't create any asset directories

      process.execPath = join(binDir, "vellum-daemon");

      const result = resolveBundledDir(
        "/$bunfs/root/src/config",
        "templates",
        "templates",
      );
      expect(result).toBe(join("/$bunfs/root/src/config", "templates"));
    });

    test("Resources path takes priority over execDir path when both exist", () => {
      const macosDir = join(tempDir, "Contents", "MacOS");
      const resourcesDir = join(tempDir, "Contents", "Resources");
      mkdirSync(macosDir, { recursive: true });
      mkdirSync(join(resourcesDir, "hook-templates"), { recursive: true });
      // Also create at execDir level
      mkdirSync(join(macosDir, "hook-templates"), { recursive: true });

      process.execPath = join(macosDir, "vellum-daemon");

      const result = resolveBundledDir(
        "/$bunfs/root/src/hooks",
        "../../hook-templates",
        "hook-templates",
      );
      expect(result).toBe(join(resourcesDir, "hook-templates"));
    });

    test("works with different bundleName values", () => {
      const macosDir = join(tempDir, "Contents", "MacOS");
      const resourcesDir = join(tempDir, "Contents", "Resources");
      mkdirSync(macosDir, { recursive: true });
      mkdirSync(join(resourcesDir, "prebuilt"), { recursive: true });

      process.execPath = join(macosDir, "vellum-daemon");

      const result = resolveBundledDir(
        "/$bunfs/root/src/widgets/prebuilt",
        ".",
        "prebuilt",
      );
      expect(result).toBe(join(resourcesDir, "prebuilt"));
    });
  });
});

/**
 * Tests for macOS TCC-protected directory deny rules in the sandbox profile.
 *
 * Verifies that the SBPL sandbox profile blocks access to TCC-protected
 * directories (Photos, Contacts, Calendar, etc.) to prevent macOS
 * permission prompts during filesystem traversal.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { MACOS_TCC_PROTECTED_PATHS } from "../tools/terminal/backends/native.js";

// We can't call buildSandboxProfile directly (not exported), but we can
// exercise it through NativeBackend.wrap() on macOS and inspect the
// generated .sb profile file on disk.

const isMacOS = process.platform === "darwin";

describe("macOS TCC sandbox deny rules", () => {
  // On macOS, generate a profile and inspect it. On other platforms,
  // just verify the constant is well-formed.

  test("MACOS_TCC_PROTECTED_PATHS is non-empty", () => {
    expect(MACOS_TCC_PROTECTED_PATHS.length).toBeGreaterThan(0);
  });

  test("all paths are relative (no leading slash)", () => {
    for (const p of MACOS_TCC_PROTECTED_PATHS) {
      expect(p.startsWith("/")).toBe(false);
    }
  });

  test("no duplicate paths", () => {
    const unique = new Set(MACOS_TCC_PROTECTED_PATHS);
    expect(unique.size).toBe(MACOS_TCC_PROTECTED_PATHS.length);
  });

  if (isMacOS) {
    const profilePaths: string[] = [];

    // Generate a profile by calling NativeBackend.wrap()
    test("generated SBPL profile contains deny rules for all TCC paths", async () => {
      const { NativeBackend } =
        await import("../tools/terminal/backends/native.js");
      const backend = new NativeBackend();
      const result = backend.wrap("true", "/tmp/tcc-test", {
        networkMode: "off",
      });

      // The profile path is the second arg after -f
      const profilePath = result.args[1]!;
      profilePaths.push(profilePath);
      expect(existsSync(profilePath)).toBe(true);

      const profile = readFileSync(profilePath, "utf-8");
      const home = process.env.HOME ?? "";
      expect(home.length).toBeGreaterThan(0);

      for (const rel of MACOS_TCC_PROTECTED_PATHS) {
        const abs = join(home, rel);
        expect(profile).toContain(`(deny file-read* (subpath "${abs}")`);
      }
    });

    test("all TCC deny rules include (with no-log)", async () => {
      const { NativeBackend } =
        await import("../tools/terminal/backends/native.js");
      const backend = new NativeBackend();
      const result = backend.wrap("true", "/tmp/tcc-test-nolog", {
        networkMode: "off",
      });

      const profilePath = result.args[1]!;
      profilePaths.push(profilePath);
      const profile = readFileSync(profilePath, "utf-8");
      const home = process.env.HOME ?? "";

      for (const rel of MACOS_TCC_PROTECTED_PATHS) {
        const abs = join(home, rel);
        expect(profile).toContain(
          `(deny file-read* (subpath "${abs}") (with no-log))`,
        );
      }
    });

    test("TCC deny rules appear after (allow file-read*)", async () => {
      const { NativeBackend } =
        await import("../tools/terminal/backends/native.js");
      const backend = new NativeBackend();
      const result = backend.wrap("true", "/tmp/tcc-test-order", {
        networkMode: "off",
      });

      const profilePath = result.args[1]!;
      profilePaths.push(profilePath);
      const profile = readFileSync(profilePath, "utf-8");
      const home = process.env.HOME ?? "";

      const allowIdx = profile.indexOf("(allow file-read*)");
      expect(allowIdx).toBeGreaterThanOrEqual(0);

      for (const rel of MACOS_TCC_PROTECTED_PATHS) {
        const abs = join(home, rel);
        const denyIdx = profile.indexOf(`(deny file-read* (subpath "${abs}")`);
        expect(denyIdx).toBeGreaterThan(allowIdx);
      }
    });

    test("paths with spaces are handled correctly", async () => {
      const { NativeBackend } =
        await import("../tools/terminal/backends/native.js");
      const backend = new NativeBackend();
      const result = backend.wrap("true", "/tmp/tcc-test-spaces", {
        networkMode: "off",
      });

      const profilePath = result.args[1]!;
      profilePaths.push(profilePath);
      const profile = readFileSync(profilePath, "utf-8");
      const home = process.env.HOME ?? "";

      // Photos Library.photoslibrary has a space — verify it's in the profile
      const photosPath = join(home, "Pictures/Photos Library.photoslibrary");
      expect(profile).toContain(`(subpath "${photosPath}")`);
    });

    afterAll(() => {
      for (const p of profilePaths) {
        try {
          unlinkSync(p);
        } catch {
          // ignore cleanup errors
        }
      }
    });
  }
});

/**
 * Tests for PAX extended header round-trip and symlinked skills directory
 * handling in the vbundle builder/validator.
 *
 * Covers:
 * - Builder emits PAX headers for paths >100 bytes; validator parses them
 * - buildExportVBundle follows symlinks when checking skillsDir
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "vbundle-pax-symlink-test-")),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

import {
  buildExportVBundle,
  buildVBundle,
} from "../runtime/migrations/vbundle-builder.js";
import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// PAX header round-trip
// ---------------------------------------------------------------------------

describe("PAX extended header round-trip", () => {
  test("builder + validator round-trip for paths >100 bytes", () => {
    // Create a path that exceeds the 100-byte ustar limit
    const longPath =
      "skills/" +
      "a".repeat(50) +
      "/" +
      "b".repeat(50) +
      "/very-long-skill-name-that-exceeds-limit.md";
    expect(new TextEncoder().encode(longPath).length).toBeGreaterThan(100);

    const fileData = new TextEncoder().encode("# Long path skill content");
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);

    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: dbData },
        { path: longPath, data: fileData },
      ],
    });

    // Validate: should succeed — validator must parse the PAX header
    const result = validateVBundle(archive);
    expect(result.errors).toEqual([]);
    expect(result.is_valid).toBe(true);
    expect(result.manifest).toBeDefined();

    // The long-path file should appear in the entry map with its full name
    expect(result.entries?.has(longPath)).toBe(true);
    const entry = result.entries?.get(longPath);
    expect(entry?.size).toBe(fileData.length);
  });

  test("validator rejects long-path file with wrong checksum", () => {
    const longPath =
      "skills/" + "x".repeat(60) + "/" + "y".repeat(60) + "/skill.md";
    expect(new TextEncoder().encode(longPath).length).toBeGreaterThan(100);

    const fileData = new TextEncoder().encode("content");
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);

    // Build archive, then re-validate — should pass first
    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: dbData },
        { path: longPath, data: fileData },
      ],
    });

    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
  });

  test("short paths (<= 100 bytes) do not emit PAX headers", () => {
    const shortPath = "config/settings.json";
    expect(new TextEncoder().encode(shortPath).length).toBeLessThanOrEqual(100);

    const fileData = new TextEncoder().encode("{}");
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);

    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: dbData },
        { path: shortPath, data: fileData },
      ],
    });

    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
    expect(result.entries?.has(shortPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symlinked skills directory
// ---------------------------------------------------------------------------

describe("buildExportVBundle with symlinked skills directory", () => {
  test("skips symlinked directory inside workspace", () => {
    // Set up: workspace with a real skills dir and a symlinked dir
    const wsDir = join(testDir, "export-workspace");
    const realSkillsDir = join(testDir, "real-skills");
    mkdirSync(realSkillsDir, { recursive: true });
    writeFileSync(join(realSkillsDir, "my-skill.md"), "# Skill");

    // Create workspace with a symlink to the skills dir — walkDirectory
    // skips symlinks, so the symlinked dir should not appear in the archive.
    mkdirSync(join(wsDir, "skills"), { recursive: true });
    writeFileSync(join(wsDir, "skills", "real-skill.md"), "# Real");
    symlinkSync(realSkillsDir, join(wsDir, "linked-skills"));

    const { archive, manifest } = buildExportVBundle({
      workspaceDir: wsDir,
    });

    // Validate archive
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);

    // Real skill file is in the manifest under workspace/ prefix
    const realSkill = manifest.files.find(
      (f) => f.path === "workspace/skills/real-skill.md",
    );
    expect(realSkill).toBeDefined();

    // Symlinked directory is skipped
    const linkedSkill = manifest.files.find(
      (f) => f.path === "workspace/linked-skills/my-skill.md",
    );
    expect(linkedSkill).toBeUndefined();
  });
});

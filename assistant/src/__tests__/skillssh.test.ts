import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { mock } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  clawhubInspect,
  clawhubInstall,
  loadIntegrityManifest,
  verifyAndRecordSkillHash,
} from "../skills/skillssh.js";

// ---------------------------------------------------------------------------
// Slug validation (exercised through public API)
// ---------------------------------------------------------------------------

describe("clawhubInstall slug validation", () => {
  test("rejects empty slug", async () => {
    const result = await clawhubInstall("");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug starting with a dot", async () => {
    const result = await clawhubInstall(".hidden");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug starting with a hyphen", async () => {
    const result = await clawhubInstall("-dashed");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug with path traversal", async () => {
    const result = await clawhubInstall("../escape");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug with spaces", async () => {
    const result = await clawhubInstall("my skill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug with double slash", async () => {
    const result = await clawhubInstall("ns//skill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug ending with slash", async () => {
    const result = await clawhubInstall("skill/");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug with special characters", async () => {
    const result = await clawhubInstall("skill@latest");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid skill slug");
  });
});

describe("clawhubInspect slug validation", () => {
  test("rejects empty slug", async () => {
    const result = await clawhubInspect("");
    expect(result.error).toContain("Invalid skill slug");
    expect(result.data).toBeUndefined();
  });

  test("rejects slug with path traversal", async () => {
    const result = await clawhubInspect("../../etc/passwd");
    expect(result.error).toContain("Invalid skill slug");
  });

  test("rejects slug with spaces", async () => {
    const result = await clawhubInspect("bad slug");
    expect(result.error).toContain("Invalid skill slug");
  });
});

// ---------------------------------------------------------------------------
// Integrity manifest edge cases — tested via verifyAndRecordSkillHash
// which is the code path that reads/writes the manifest.
// ---------------------------------------------------------------------------

describe("integrity manifest", () => {
  function createSkillFiles(slug: string): void {
    const skillDir = join(TEST_DIR, "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Test Skill\n", "utf-8");
  }

  test("malformed integrity JSON is handled gracefully", () => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    const integrityPath = join(TEST_DIR, "skills", ".integrity.json");
    writeFileSync(integrityPath, "{not valid json!!!", "utf-8");
    createSkillFiles("valid-slug");

    // Should not throw — malformed manifest is replaced with a fresh one
    verifyAndRecordSkillHash("valid-slug");

    // Manifest should now contain a valid entry
    const manifest = loadIntegrityManifest();
    expect(manifest["valid-slug"]).toBeDefined();
    expect(manifest["valid-slug"].sha256).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test("missing integrity manifest is created on first install", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const integrityPath = join(skillsDir, ".integrity.json");
    // Remove any manifest left by earlier tests so we test the fresh-creation path
    rmSync(integrityPath, { force: true });
    expect(existsSync(integrityPath)).toBe(false);
    createSkillFiles("new-skill");

    verifyAndRecordSkillHash("new-skill");

    // Manifest should now exist with the skill's hash
    expect(existsSync(integrityPath)).toBe(true);
    const manifest = loadIntegrityManifest();
    expect(manifest["new-skill"]).toBeDefined();
    expect(manifest["new-skill"].sha256).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test("re-install with same content preserves hash", () => {
    createSkillFiles("stable-skill");

    verifyAndRecordSkillHash("stable-skill");
    const first = loadIntegrityManifest()["stable-skill"].sha256;

    verifyAndRecordSkillHash("stable-skill");
    const second = loadIntegrityManifest()["stable-skill"].sha256;

    expect(first).toBe(second);
  });

  test("re-install with changed content updates hash", () => {
    createSkillFiles("changing-skill");
    verifyAndRecordSkillHash("changing-skill");
    const first = loadIntegrityManifest()["changing-skill"].sha256;

    // Modify skill content
    writeFileSync(
      join(TEST_DIR, "skills", "changing-skill", "SKILL.md"),
      "# Updated\n",
      "utf-8",
    );
    verifyAndRecordSkillHash("changing-skill");
    const second = loadIntegrityManifest()["changing-skill"].sha256;

    expect(first).not.toBe(second);
  });
});

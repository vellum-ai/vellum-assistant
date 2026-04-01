import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  verifyAndRecordSkillHash,
} from "../skills/clawhub.js";
import type { SkillInstallMeta } from "../skills/install-meta.js";

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
// Content hash verification — tested via verifyAndRecordSkillHash
// which reads legacy .integrity.json but always writes to install-meta.json.
// ---------------------------------------------------------------------------

describe("content hash verification", () => {
  function createSkillFiles(slug: string): void {
    const skillDir = join(TEST_DIR, "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Test Skill\n", "utf-8");
  }

  function readSkillInstallMeta(slug: string): SkillInstallMeta {
    const metaPath = join(TEST_DIR, "skills", slug, "install-meta.json");
    return JSON.parse(readFileSync(metaPath, "utf-8")) as SkillInstallMeta;
  }

  test("malformed integrity JSON is handled gracefully", () => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    const integrityPath = join(TEST_DIR, "skills", ".integrity.json");
    writeFileSync(integrityPath, "{not valid json!!!", "utf-8");
    createSkillFiles("valid-slug");

    // Should not throw — malformed legacy manifest is ignored; install-meta.json is created
    verifyAndRecordSkillHash("valid-slug");

    // install-meta.json should now contain a valid hash
    const meta = readSkillInstallMeta("valid-slug");
    expect(meta.contentHash).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(meta.origin).toBe("clawhub");
    expect(meta.slug).toBe("valid-slug");
  });

  test("install-meta.json is created on first hash verification for skills without one", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(skillsDir, { recursive: true });
    createSkillFiles("new-skill");
    const metaPath = join(skillsDir, "new-skill", "install-meta.json");
    // Remove any install-meta left by earlier tests
    rmSync(metaPath, { force: true });
    expect(existsSync(metaPath)).toBe(false);

    verifyAndRecordSkillHash("new-skill");

    // install-meta.json should now exist with the skill's hash
    expect(existsSync(metaPath)).toBe(true);
    const meta = readSkillInstallMeta("new-skill");
    expect(meta.contentHash).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(meta.origin).toBe("clawhub");
    expect(meta.slug).toBe("new-skill");
  });

  test("re-install with same content preserves hash", () => {
    createSkillFiles("stable-skill");

    verifyAndRecordSkillHash("stable-skill");
    const first = readSkillInstallMeta("stable-skill").contentHash;

    verifyAndRecordSkillHash("stable-skill");
    const second = readSkillInstallMeta("stable-skill").contentHash;

    expect(first).toBe(second);
  });

  test("re-install with changed content updates hash", () => {
    createSkillFiles("changing-skill");
    verifyAndRecordSkillHash("changing-skill");
    const first = readSkillInstallMeta("changing-skill").contentHash;

    // Modify skill content
    writeFileSync(
      join(TEST_DIR, "skills", "changing-skill", "SKILL.md"),
      "# Updated\n",
      "utf-8",
    );
    verifyAndRecordSkillHash("changing-skill");
    const second = readSkillInstallMeta("changing-skill").contentHash;

    expect(first).not.toBe(second);
  });

  test(".integrity.json is never written to", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const integrityPath = join(skillsDir, ".integrity.json");
    // Remove any legacy manifest
    rmSync(integrityPath, { force: true });
    createSkillFiles("no-integrity-write");

    verifyAndRecordSkillHash("no-integrity-write");

    // .integrity.json should NOT have been created
    expect(existsSync(integrityPath)).toBe(false);
    // But install-meta.json should exist
    const metaPath = join(skillsDir, "no-integrity-write", "install-meta.json");
    expect(existsSync(metaPath)).toBe(true);
  });
});

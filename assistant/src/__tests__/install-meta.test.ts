import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  collectFileContents,
  computeSkillHash,
  readInstallMeta,
  type SkillInstallMeta,
  writeInstallMeta,
} from "../skills/install-meta.js";

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "install-meta-test-"));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── writeInstallMeta ───────────────────────────────────────────────────────

describe("writeInstallMeta", () => {
  test("writes a valid install-meta.json with all required fields", () => {
    const dir = makeTempDir();
    const meta: SkillInstallMeta = {
      origin: "vellum",
      installedAt: "2025-01-15T10:30:00.000Z",
      version: "1.2.3",
    };

    writeInstallMeta(dir, meta);

    const filePath = join(dir, "install-meta.json");
    expect(existsSync(filePath)).toBe(true);

    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.origin).toBe("vellum");
    expect(parsed.installedAt).toBe("2025-01-15T10:30:00.000Z");
    expect(parsed.version).toBe("1.2.3");
  });

  test("writes install-meta.json with optional installedBy field", () => {
    const dir = makeTempDir();
    const meta: SkillInstallMeta = {
      origin: "clawhub",
      installedAt: "2025-02-20T14:00:00.000Z",
      slug: "my-cool-skill",
      installedBy: "contact-uuid-123",
    };

    writeInstallMeta(dir, meta);

    const parsed = JSON.parse(
      readFileSync(join(dir, "install-meta.json"), "utf-8"),
    );
    expect(parsed.installedBy).toBe("contact-uuid-123");
    expect(parsed.origin).toBe("clawhub");
    expect(parsed.slug).toBe("my-cool-skill");
  });

  test("writes install-meta.json with skillssh origin and sourceRepo", () => {
    const dir = makeTempDir();
    const meta: SkillInstallMeta = {
      origin: "skillssh",
      installedAt: "2025-03-01T00:00:00.000Z",
      sourceRepo: "vercel-labs/agent-skills",
      slug: "vercel-react-best-practices",
    };

    writeInstallMeta(dir, meta);

    const parsed = JSON.parse(
      readFileSync(join(dir, "install-meta.json"), "utf-8"),
    );
    expect(parsed.origin).toBe("skillssh");
    expect(parsed.sourceRepo).toBe("vercel-labs/agent-skills");
    expect(parsed.slug).toBe("vercel-react-best-practices");
  });

  test("writes install-meta.json with contentHash", () => {
    const dir = makeTempDir();
    const meta: SkillInstallMeta = {
      origin: "vellum",
      installedAt: "2025-04-01T00:00:00.000Z",
      contentHash: "v2:abc123def456",
    };

    writeInstallMeta(dir, meta);

    const parsed = JSON.parse(
      readFileSync(join(dir, "install-meta.json"), "utf-8"),
    );
    expect(parsed.contentHash).toBe("v2:abc123def456");
  });

  test("overwrites existing install-meta.json", () => {
    const dir = makeTempDir();
    writeInstallMeta(dir, {
      origin: "vellum",
      installedAt: "2025-01-01T00:00:00.000Z",
      version: "1.0.0",
    });
    writeInstallMeta(dir, {
      origin: "vellum",
      installedAt: "2025-06-01T00:00:00.000Z",
      version: "2.0.0",
    });

    const parsed = JSON.parse(
      readFileSync(join(dir, "install-meta.json"), "utf-8"),
    );
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.installedAt).toBe("2025-06-01T00:00:00.000Z");
  });

  test("creates parent directories if needed", () => {
    const dir = makeTempDir();
    const nested = join(dir, "nested", "skill");
    // nested doesn't exist yet
    writeInstallMeta(nested, {
      origin: "custom",
      installedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(existsSync(join(nested, "install-meta.json"))).toBe(true);
  });
});

// ─── readInstallMeta ────────────────────────────────────────────────────────

describe("readInstallMeta", () => {
  test("reads install-meta.json when it exists", () => {
    const dir = makeTempDir();
    const meta: SkillInstallMeta = {
      origin: "clawhub",
      installedAt: "2025-01-15T10:30:00.000Z",
      slug: "find-skills",
      installedBy: "contact-42",
    };
    writeInstallMeta(dir, meta);

    const result = readInstallMeta(dir);
    expect(result).not.toBeNull();
    expect(result!.origin).toBe("clawhub");
    expect(result!.installedAt).toBe("2025-01-15T10:30:00.000Z");
    expect(result!.slug).toBe("find-skills");
    expect(result!.installedBy).toBe("contact-42");
  });

  test("returns null when neither file exists", () => {
    const dir = makeTempDir();
    expect(readInstallMeta(dir)).toBeNull();
  });

  test("returns null for malformed install-meta.json when no version.json exists", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "install-meta.json"),
      "{not valid json!!!",
      "utf-8",
    );
    expect(readInstallMeta(dir)).toBeNull();
  });

  test("falls back to version.json when install-meta.json is malformed", () => {
    const dir = makeTempDir();
    // Write a malformed install-meta.json
    writeFileSync(
      join(dir, "install-meta.json"),
      "{not valid json!!!",
      "utf-8",
    );
    // Write a valid legacy version.json
    writeFileSync(
      join(dir, "version.json"),
      JSON.stringify({
        version: "v1:abc123",
        installedAt: "2025-02-01T08:00:00.000Z",
      }),
      "utf-8",
    );

    const result = readInstallMeta(dir);
    expect(result).not.toBeNull();
    expect(result!.origin).toBe("vellum");
    expect(result!.version).toBe("v1:abc123");
    expect(result!.installedAt).toBe("2025-02-01T08:00:00.000Z");
  });

  // ─── Legacy version.json fallback ──────────────────────────────────────

  describe("legacy version.json fallback", () => {
    test("infers skillssh origin from version.json with origin: skills.sh", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, "version.json"),
        JSON.stringify({
          origin: "skills.sh",
          source: "vercel-labs/agent-skills",
          skillSlug: "vercel-react-best-practices",
          installedAt: "2025-01-10T12:00:00.000Z",
        }),
        "utf-8",
      );

      const result = readInstallMeta(dir);
      expect(result).not.toBeNull();
      expect(result!.origin).toBe("skillssh");
      expect(result!.sourceRepo).toBe("vercel-labs/agent-skills");
      expect(result!.slug).toBe("vercel-react-best-practices");
      expect(result!.installedAt).toBe("2025-01-10T12:00:00.000Z");
      expect(result!.installedBy).toBeUndefined();
    });

    test("infers vellum origin from version.json with version but no origin", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, "version.json"),
        JSON.stringify({
          version: "v1:abc123",
          installedAt: "2025-02-01T08:00:00.000Z",
        }),
        "utf-8",
      );

      const result = readInstallMeta(dir);
      expect(result).not.toBeNull();
      expect(result!.origin).toBe("vellum");
      expect(result!.version).toBe("v1:abc123");
      expect(result!.installedAt).toBe("2025-02-01T08:00:00.000Z");
      expect(result!.installedBy).toBeUndefined();
    });

    test("infers custom origin from version.json without version or origin", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, "version.json"),
        JSON.stringify({
          installedAt: "2025-03-15T00:00:00.000Z",
          someOtherField: "data",
        }),
        "utf-8",
      );

      const result = readInstallMeta(dir);
      expect(result).not.toBeNull();
      expect(result!.origin).toBe("custom");
      expect(result!.installedAt).toBe("2025-03-15T00:00:00.000Z");
      expect(result!.installedBy).toBeUndefined();
    });

    test("handles version.json with unknown origin field as custom", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, "version.json"),
        JSON.stringify({
          origin: "unknown-registry",
          installedAt: "2025-04-01T00:00:00.000Z",
        }),
        "utf-8",
      );

      const result = readInstallMeta(dir);
      expect(result).not.toBeNull();
      expect(result!.origin).toBe("custom");
    });

    test("returns null for malformed version.json", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, "version.json"), "{bad json!", "utf-8");
      expect(readInstallMeta(dir)).toBeNull();
    });

    test("prefers install-meta.json over version.json when both exist", () => {
      const dir = makeTempDir();
      writeInstallMeta(dir, {
        origin: "clawhub",
        installedAt: "2025-06-01T00:00:00.000Z",
        slug: "from-install-meta",
      });
      writeFileSync(
        join(dir, "version.json"),
        JSON.stringify({
          origin: "skills.sh",
          source: "other/repo",
          skillSlug: "from-version-json",
          installedAt: "2025-01-01T00:00:00.000Z",
        }),
        "utf-8",
      );

      const result = readInstallMeta(dir);
      expect(result).not.toBeNull();
      expect(result!.origin).toBe("clawhub");
      expect(result!.slug).toBe("from-install-meta");
    });

    test("falls back when installedAt is missing in legacy version.json", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
        "utf-8",
      );

      const result = readInstallMeta(dir);
      expect(result).not.toBeNull();
      expect(result!.origin).toBe("vellum");
      // Should have a generated installedAt since the file lacked one
      expect(typeof result!.installedAt).toBe("string");
      expect(new Date(result!.installedAt).getTime()).not.toBeNaN();
    });
  });
});

// ─── computeSkillHash ───────────────────────────────────────────────────────

describe("computeSkillHash", () => {
  test("returns a v2: prefixed sha256 hash", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "SKILL.md"), "# My Skill\n");
    const hash = computeSkillHash(dir);
    expect(hash).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test("is deterministic for same content", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "SKILL.md"), "# My Skill\n");
    writeFileSync(join(dir, "executor.ts"), "export const run = () => {};");
    const hash1 = computeSkillHash(dir);
    const hash2 = computeSkillHash(dir);
    expect(hash1).toBe(hash2);
  });

  test("changes when file content changes", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "executor.ts"), 'export const run = () => "v1";');
    const hash1 = computeSkillHash(dir);

    writeFileSync(join(dir, "executor.ts"), 'export const run = () => "v2";');
    const hash2 = computeSkillHash(dir);

    expect(hash1).not.toBe(hash2);
  });

  test("changes when a new file is added", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "SKILL.md"), "# Skill\n");
    const hash1 = computeSkillHash(dir);

    writeFileSync(join(dir, "extra.ts"), "export {};");
    const hash2 = computeSkillHash(dir);

    expect(hash1).not.toBe(hash2);
  });

  test("is insensitive to file creation order", () => {
    const dir1 = makeTempDir();
    writeFileSync(join(dir1, "b.ts"), "b");
    writeFileSync(join(dir1, "a.ts"), "a");

    const dir2 = makeTempDir();
    writeFileSync(join(dir2, "a.ts"), "a");
    writeFileSync(join(dir2, "b.ts"), "b");

    expect(computeSkillHash(dir1)).toBe(computeSkillHash(dir2));
  });

  test("returns null for non-existent directory", () => {
    expect(computeSkillHash("/tmp/nonexistent-dir-xyz")).toBeNull();
  });

  test("returns null for a file path (not a directory)", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "not-a-dir.txt");
    writeFileSync(filePath, "hello");
    expect(computeSkillHash(filePath)).toBeNull();
  });

  test("returns null for empty directory", () => {
    const dir = makeTempDir();
    expect(computeSkillHash(dir)).toBeNull();
  });

  test("includes subdirectory files", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "SKILL.md"), "# Skill\n");
    const hash1 = computeSkillHash(dir);

    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "helper.ts"), "export {};");
    const hash2 = computeSkillHash(dir);

    expect(hash1).not.toBe(hash2);
  });

  test("excludes install-meta.json and version.json from the hash", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "SKILL.md"), "# My Skill\n");
    const hashBefore = computeSkillHash(dir);

    // Adding install-meta.json should not change the hash
    writeFileSync(
      join(dir, "install-meta.json"),
      JSON.stringify({
        origin: "vellum",
        installedAt: "2025-01-01T00:00:00.000Z",
        contentHash: hashBefore,
      }),
      "utf-8",
    );
    expect(computeSkillHash(dir)).toBe(hashBefore);

    // Adding version.json should not change the hash either
    writeFileSync(
      join(dir, "version.json"),
      JSON.stringify({ version: "v1:abc123" }),
      "utf-8",
    );
    expect(computeSkillHash(dir)).toBe(hashBefore);
  });
});

// ─── collectFileContents ────────────────────────────────────────────────────

describe("collectFileContents", () => {
  test("returns empty array for non-existent directory", () => {
    expect(collectFileContents("/tmp/nonexistent-xyz")).toEqual([]);
  });

  test("returns empty array for empty directory", () => {
    const dir = makeTempDir();
    expect(collectFileContents(dir)).toEqual([]);
  });

  test("collects files sorted by relative path", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "c.txt"), "c");
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");

    const results = collectFileContents(dir);
    expect(results.map((r) => r.relPath)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("includes files from subdirectories", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "root.txt"), "root");
    writeFileSync(join(dir, "sub", "nested.txt"), "nested");

    const results = collectFileContents(dir);
    expect(results.map((r) => r.relPath)).toEqual([
      "root.txt",
      "sub/nested.txt",
    ]);
  });

  test("reads correct file content", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "hello.txt"), "Hello, World!");

    const results = collectFileContents(dir);
    expect(results).toHaveLength(1);
    expect(results[0].content.toString("utf-8")).toBe("Hello, World!");
  });

  test("excludes install-meta.json and version.json at root level", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "SKILL.md"), "# Skill\n");
    writeFileSync(join(dir, "install-meta.json"), '{"origin":"vellum"}');
    writeFileSync(join(dir, "version.json"), '{"version":"1.0.0"}');

    const results = collectFileContents(dir);
    const names = results.map((r) => r.relPath);
    expect(names).toEqual(["SKILL.md"]);
    expect(names).not.toContain("install-meta.json");
    expect(names).not.toContain("version.json");
  });

  test("does not exclude install-meta.json or version.json in subdirectories", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "install-meta.json"), "nested");
    writeFileSync(join(dir, "sub", "version.json"), "nested");

    const results = collectFileContents(dir);
    const names = results.map((r) => r.relPath);
    expect(names).toContain("sub/install-meta.json");
    expect(names).toContain("sub/version.json");
  });
});

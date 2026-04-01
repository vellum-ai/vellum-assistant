import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { backfillInstallMetaMigration } from "../workspace/migrations/026-backfill-install-meta.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let skillsDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-026-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  skillsDir = join(workspaceDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
}

function createSkillDir(
  name: string,
  opts?: {
    skillMd?: string;
    versionJson?: Record<string, unknown>;
    installMetaJson?: Record<string, unknown>;
    extraFiles?: Record<string, string>;
  },
): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });

  if (opts?.skillMd !== undefined) {
    writeFileSync(join(dir, "SKILL.md"), opts.skillMd, "utf-8");
  } else {
    // Default: create a SKILL.md so the dir is recognized as a skill
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
  }

  if (opts?.versionJson) {
    writeFileSync(
      join(dir, "version.json"),
      JSON.stringify(opts.versionJson, null, 2),
      "utf-8",
    );
  }

  if (opts?.installMetaJson) {
    writeFileSync(
      join(dir, "install-meta.json"),
      JSON.stringify(opts.installMetaJson, null, 2),
      "utf-8",
    );
  }

  if (opts?.extraFiles) {
    for (const [filePath, content] of Object.entries(opts.extraFiles)) {
      const fullPath = join(dir, filePath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }
  }

  return dir;
}

function writeIntegrityManifest(
  manifest: Record<string, { sha256: string; installedAt: string }>,
): void {
  writeFileSync(
    join(skillsDir, ".integrity.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

function readInstallMeta(skillName: string): Record<string, unknown> | null {
  const path = join(skillsDir, skillName, "install-meta.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const dirs: string[] = [];

beforeEach(() => {
  freshWorkspace();
  dirs.push(workspaceDir);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("026-backfill-install-meta migration", () => {
  test("has correct migration id", () => {
    expect(backfillInstallMetaMigration.id).toBe("026-backfill-install-meta");
  });

  // ─── No-op cases ────────────────────────────────────────────────────────

  test("no-op when skills dir does not exist", () => {
    rmSync(skillsDir, { recursive: true, force: true });
    // Should not throw
    backfillInstallMetaMigration.run(workspaceDir);
  });

  test("no-op when skills dir is empty", () => {
    backfillInstallMetaMigration.run(workspaceDir);
    // No install-meta.json should be created
  });

  test("skips directories without SKILL.md", () => {
    const dir = join(skillsDir, "not-a-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# Not a skill", "utf-8");

    backfillInstallMetaMigration.run(workspaceDir);

    expect(existsSync(join(dir, "install-meta.json"))).toBe(false);
  });

  test("skips non-directory entries", () => {
    writeFileSync(join(skillsDir, "some-file.txt"), "not a dir", "utf-8");

    backfillInstallMetaMigration.run(workspaceDir);
    // Should not throw
  });

  // ─── Idempotency ───────────────────────────────────────────────────────

  test("skips skills that already have install-meta.json", () => {
    const existingMeta = {
      origin: "clawhub",
      installedAt: "2025-01-01T00:00:00.000Z",
      installedBy: "user-123",
      slug: "existing-skill",
    };
    createSkillDir("my-skill", { installMetaJson: existingMeta });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("my-skill");
    expect(meta).not.toBeNull();
    expect(meta!.installedBy).toBe("user-123"); // preserved, not overwritten
    expect(meta!.origin).toBe("clawhub");
  });

  test("is idempotent — running twice produces same result", () => {
    createSkillDir("my-skill", {
      versionJson: {
        version: "1.0.0",
        installedAt: "2025-03-01T00:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);
    const meta1 = readInstallMeta("my-skill");

    backfillInstallMetaMigration.run(workspaceDir);
    const meta2 = readInstallMeta("my-skill");

    expect(meta1).toEqual(meta2);
  });

  // ─── Case 1: skills.sh origin ──────────────────────────────────────────

  test("infers skillssh origin from version.json with origin: skills.sh", () => {
    createSkillDir("skillssh-skill", {
      versionJson: {
        origin: "skills.sh",
        source: "vercel-labs/agent-skills",
        skillSlug: "react-best-practices",
        installedAt: "2025-02-15T12:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("skillssh-skill");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("skillssh");
    expect(meta!.sourceRepo).toBe("vercel-labs/agent-skills");
    expect(meta!.slug).toBe("react-best-practices");
    expect(meta!.installedAt).toBe("2025-02-15T12:00:00.000Z");
    expect(meta!.installedBy).toBeUndefined();
    expect(meta!.contentHash).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  // ─── Case 2: version with no origin (vellum or clawhub) ───────────────

  test("infers vellum origin from version.json with version and no origin", () => {
    createSkillDir("vellum-skill", {
      versionJson: {
        version: "v1:abc123",
        installedAt: "2025-01-20T08:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("vellum-skill");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("vellum");
    expect(meta!.version).toBe("v1:abc123");
    expect(meta!.installedAt).toBe("2025-01-20T08:00:00.000Z");
    expect(meta!.installedBy).toBeUndefined();
    expect(meta!.contentHash).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test("infers clawhub origin when version.json has version, no origin, and integrity entry exists", () => {
    createSkillDir("clawhub-skill", {
      versionJson: {
        version: "1.2.3",
        installedAt: "2025-03-10T10:00:00.000Z",
      },
    });
    writeIntegrityManifest({
      "clawhub-skill": {
        sha256:
          "v2:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        installedAt: "2025-03-10T10:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("clawhub-skill");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("clawhub");
    expect(meta!.version).toBe("1.2.3");
    expect(meta!.installedAt).toBe("2025-03-10T10:00:00.000Z");
    expect(meta!.installedBy).toBeUndefined();
  });

  // ─── Case 3: version.json with unknown pattern ─────────────────────────

  test("infers custom origin from version.json with unrecognized structure", () => {
    createSkillDir("weird-skill", {
      versionJson: {
        origin: "some-unknown-registry",
        installedAt: "2025-04-01T00:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("weird-skill");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("custom");
    expect(meta!.installedAt).toBe("2025-04-01T00:00:00.000Z");
    expect(meta!.installedBy).toBeUndefined();
  });

  test("infers custom origin from version.json with version AND origin fields", () => {
    createSkillDir("both-fields", {
      versionJson: {
        origin: "some-origin",
        version: "2.0.0",
        installedAt: "2025-05-01T00:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("both-fields");
    expect(meta).not.toBeNull();
    // Has `origin` field (not "skills.sh") AND `version` -> doesn't match case 2
    // (case 2 requires no `origin` field), falls through to case 3 (custom)
    expect(meta!.origin).toBe("custom");
  });

  // ─── Case 4: no version.json ──────────────────────────────────────────

  test("infers clawhub origin when no version.json but integrity entry exists", () => {
    createSkillDir("clawhub-no-version", {});
    writeIntegrityManifest({
      "clawhub-no-version": {
        sha256:
          "v2:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        installedAt: "2025-06-01T00:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("clawhub-no-version");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("clawhub");
    expect(meta!.installedBy).toBeUndefined();
    // installedAt should be directory mtime (an ISO string)
    expect(typeof meta!.installedAt).toBe("string");
    expect(new Date(meta!.installedAt as string).getTime()).not.toBeNaN();
  });

  test("infers custom origin when no version.json and no integrity entry", () => {
    createSkillDir("custom-skill", {});

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("custom-skill");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("custom");
    expect(meta!.installedBy).toBeUndefined();
    expect(typeof meta!.installedAt).toBe("string");
  });

  // ─── Malformed version.json ───────────────────────────────────────────

  test("handles malformed version.json gracefully", () => {
    const dir = createSkillDir("bad-version");
    writeFileSync(join(dir, "version.json"), "{bad json!", "utf-8");

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("bad-version");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("custom");
    expect(meta!.installedBy).toBeUndefined();
  });

  test("handles malformed version.json with integrity entry as clawhub", () => {
    const dir = createSkillDir("bad-version-clawhub");
    writeFileSync(join(dir, "version.json"), "{{{", "utf-8");
    writeIntegrityManifest({
      "bad-version-clawhub": {
        sha256: "v2:aaa",
        installedAt: "2025-01-01T00:00:00.000Z",
      },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("bad-version-clawhub");
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("clawhub");
  });

  // ─── Content hash ─────────────────────────────────────────────────────

  test("computes contentHash for all backfilled skills", () => {
    createSkillDir("hash-test", {
      versionJson: {
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00.000Z",
      },
      extraFiles: { "executor.ts": "export const run = () => {};" },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("hash-test");
    expect(meta).not.toBeNull();
    expect(meta!.contentHash).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  // ─── Legacy file preservation ─────────────────────────────────────────

  test("preserves legacy version.json after backfill", () => {
    const versionData = {
      version: "1.0.0",
      installedAt: "2025-01-01T00:00:00.000Z",
    };
    const dir = createSkillDir("preserve-version", {
      versionJson: versionData,
    });

    backfillInstallMetaMigration.run(workspaceDir);

    // version.json should still exist
    const versionPath = join(dir, "version.json");
    expect(existsSync(versionPath)).toBe(true);
    const preserved = JSON.parse(readFileSync(versionPath, "utf-8"));
    expect(preserved.version).toBe("1.0.0");
  });

  test("preserves .integrity.json after backfill", () => {
    createSkillDir("preserve-integrity", {
      versionJson: {
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const manifestData = {
      "preserve-integrity": {
        sha256: "v2:abc",
        installedAt: "2025-01-01T00:00:00.000Z",
      },
    };
    writeIntegrityManifest(manifestData);

    backfillInstallMetaMigration.run(workspaceDir);

    const integrityPath = join(skillsDir, ".integrity.json");
    expect(existsSync(integrityPath)).toBe(true);
    const preserved = JSON.parse(readFileSync(integrityPath, "utf-8"));
    expect(preserved["preserve-integrity"]).toBeDefined();
  });

  // ─── Multiple skills ──────────────────────────────────────────────────

  test("processes multiple skill directories in a single run", () => {
    createSkillDir("skill-a", {
      versionJson: {
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    createSkillDir("skill-b", {
      versionJson: {
        origin: "skills.sh",
        source: "org/repo",
        skillSlug: "slug-b",
        installedAt: "2025-02-01T00:00:00.000Z",
      },
    });
    createSkillDir("skill-c", {}); // no version.json

    backfillInstallMetaMigration.run(workspaceDir);

    const metaA = readInstallMeta("skill-a");
    const metaB = readInstallMeta("skill-b");
    const metaC = readInstallMeta("skill-c");

    expect(metaA).not.toBeNull();
    expect(metaA!.origin).toBe("vellum");

    expect(metaB).not.toBeNull();
    expect(metaB!.origin).toBe("skillssh");

    expect(metaC).not.toBeNull();
    expect(metaC!.origin).toBe("custom");
  });

  // ─── installedAt fallback ─────────────────────────────────────────────

  test("uses directory mtime as installedAt when version.json lacks it", () => {
    createSkillDir("no-installed-at", {
      versionJson: { version: "1.0.0" },
    });

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("no-installed-at");
    expect(meta).not.toBeNull();
    // Should be an ISO date from dir mtime
    expect(typeof meta!.installedAt).toBe("string");
    expect(new Date(meta!.installedAt as string).getTime()).not.toBeNaN();
  });

  test("uses directory mtime as installedAt when no version.json exists", () => {
    createSkillDir("mtime-fallback", {});

    backfillInstallMetaMigration.run(workspaceDir);

    const meta = readInstallMeta("mtime-fallback");
    expect(meta).not.toBeNull();
    expect(typeof meta!.installedAt).toBe("string");
    expect(new Date(meta!.installedAt as string).getTime()).not.toBeNaN();
  });

  // ─── down() rollback ──────────────────────────────────────────────────

  describe("down()", () => {
    test("removes backfilled install-meta.json files", () => {
      createSkillDir("rollback-skill", {
        versionJson: {
          version: "1.0.0",
          installedAt: "2025-01-01T00:00:00.000Z",
        },
      });

      backfillInstallMetaMigration.run(workspaceDir);
      expect(
        existsSync(join(skillsDir, "rollback-skill", "install-meta.json")),
      ).toBe(true);

      backfillInstallMetaMigration.down(workspaceDir);
      expect(
        existsSync(join(skillsDir, "rollback-skill", "install-meta.json")),
      ).toBe(false);
    });

    test("preserves install-meta.json with installedBy (not backfilled)", () => {
      createSkillDir("keep-skill", {
        installMetaJson: {
          origin: "clawhub",
          installedAt: "2025-01-01T00:00:00.000Z",
          installedBy: "user-abc",
          slug: "my-skill",
        },
      });

      backfillInstallMetaMigration.down(workspaceDir);

      expect(
        existsSync(join(skillsDir, "keep-skill", "install-meta.json")),
      ).toBe(true);
    });

    test("is idempotent — calling down() twice is safe", () => {
      createSkillDir("double-down", {
        versionJson: {
          version: "1.0.0",
          installedAt: "2025-01-01T00:00:00.000Z",
        },
      });

      backfillInstallMetaMigration.run(workspaceDir);
      backfillInstallMetaMigration.down(workspaceDir);
      backfillInstallMetaMigration.down(workspaceDir); // second call

      expect(
        existsSync(join(skillsDir, "double-down", "install-meta.json")),
      ).toBe(false);
    });

    test("no-op when skills dir does not exist", () => {
      rmSync(skillsDir, { recursive: true, force: true });
      // Should not throw
      backfillInstallMetaMigration.down(workspaceDir);
    });

    test("no-op when skills dir is empty", () => {
      // Should not throw
      backfillInstallMetaMigration.down(workspaceDir);
    });

    test("handles malformed install-meta.json in down() gracefully", () => {
      const dir = createSkillDir("bad-meta");
      writeFileSync(join(dir, "install-meta.json"), "{not valid}", "utf-8");

      // Should not throw
      backfillInstallMetaMigration.down(workspaceDir);

      // The malformed file is left in place (skip, not crash)
      expect(existsSync(join(dir, "install-meta.json"))).toBe(true);
    });
  });
});

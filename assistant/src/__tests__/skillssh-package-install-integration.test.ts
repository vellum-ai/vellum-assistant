import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Integration test for the package install flow.
 *
 * Tests that:
 * 1. resolveSkillSource correctly parses 2-segment (package) vs 3-segment (single-skill) formats
 * 2. listPackageSkills discovers skills in a mock repo
 * 3. installPackage installs all skills with namespaced paths and metadata
 */

describe("package install integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skill-install-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolveSkillSource parses package format (owner/repo) correctly", async () => {
    const { resolveSkillSource } = await import(
      "../skills/skillssh-registry.js"
    );

    const result = resolveSkillSource("obra/superpowers");

    expect(result.owner).toBe("obra");
    expect(result.repo).toBe("superpowers");
    expect(result.isPackageInstall).toBe(true);
    expect(result.skillSlug).toBeUndefined();
  });

  it("resolveSkillSource parses single-skill format (owner/repo/skill) correctly", async () => {
    const { resolveSkillSource } = await import(
      "../skills/skillssh-registry.js"
    );

    const result = resolveSkillSource("obra/superpowers/brainstorming");

    expect(result.owner).toBe("obra");
    expect(result.repo).toBe("superpowers");
    expect(result.skillSlug).toBe("brainstorming");
    expect(result.isPackageInstall).toBe(false);
  });

  it("resolveSkillSource parses @ format (owner/repo@skill) correctly", async () => {
    const { resolveSkillSource } = await import(
      "../skills/skillssh-registry.js"
    );

    const result = resolveSkillSource("obra/superpowers@brainstorming");

    expect(result.owner).toBe("obra");
    expect(result.repo).toBe("superpowers");
    expect(result.skillSlug).toBe("brainstorming");
    expect(result.isPackageInstall).toBe(false);
  });

  it("validateSkillSlug accepts namespaced 3-segment format", async () => {
    const { validateSkillSlug } = await import(
      "../skills/skillssh-registry.js"
    );

    // Should not throw
    expect(() =>
      validateSkillSlug("obra/superpowers/brainstorming"),
    ).not.toThrow();
    expect(() =>
      validateSkillSlug("my-org/my-repo/my-skill"),
    ).not.toThrow();
  });

  it("validateSkillSlug rejects 2-segment format (reserved for package arg)", async () => {
    const { validateSkillSlug } = await import(
      "../skills/skillssh-registry.js"
    );

    expect(() => validateSkillSlug("foo/bar")).toThrow();
    expect(() => validateSkillSlug("obra/superpowers")).toThrow();
  });

  it("validateSkillSlug accepts single-segment format (legacy)", async () => {
    const { validateSkillSlug } = await import(
      "../skills/skillssh-registry.js"
    );

    // Should not throw
    expect(() => validateSkillSlug("my-skill")).not.toThrow();
    expect(() => validateSkillSlug("brainstorming")).not.toThrow();
  });

  it("listPackageSkills discovers skills from mock conventional layout", async () => {
    const { listPackageSkills } = await import(
      "../skills/skillssh-package-discovery.js"
    );

    const originalFetch = global.fetch;
    const mockFetch = mock((url: string) => {
      // Mock GitHub Contents API for skills/ directory
      if (url.includes("/contents/skills") && !url.includes("SKILL.md")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { name: "brainstorming", type: "dir" },
              { name: "outlining", type: "dir" },
              { name: "README.md", type: "file" },
            ]),
            { status: 200 },
          ),
        );
      }

      // Mock SKILL.md checks
      if (url.includes("/SKILL.md")) {
        return Promise.resolve(new Response("# Skill", { status: 200 }));
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const skills = await listPackageSkills("obra", "superpowers");

      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.slug).sort()).toEqual([
        "brainstorming",
        "outlining",
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("install-meta roundtrip includes package metadata", async () => {
    const { writeInstallMeta, readInstallMeta } = await import(
      "../skills/install-meta.js"
    );

    const meta = {
      origin: "skillssh" as const,
      installedAt: "2025-01-01T00:00:00.000Z",
      slug: "obra/superpowers/brainstorming",
      sourceRepo: "obra/superpowers",
      package: "obra/superpowers",
      packageContentHash: "v2:abc123",
    };

    writeInstallMeta(tempDir, meta);
    const read = readInstallMeta(tempDir);

    expect(read).not.toBeNull();
    expect(read!.package).toBe("obra/superpowers");
    expect(read!.packageContentHash).toBe("v2:abc123");
    expect(read!.slug).toBe("obra/superpowers/brainstorming");
  });
});

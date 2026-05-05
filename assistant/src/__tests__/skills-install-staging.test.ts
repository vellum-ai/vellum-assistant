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
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const mockExecSync = mock(() => {});

mock.module("node:child_process", () => ({
  execSync: mockExecSync,
}));

import { loadSkillCatalog } from "../config/skills.js";
import { installSkillLocally } from "../skills/catalog-install.js";
import { installExternalSkill } from "../skills/skillssh-registry.js";
import { makeTar } from "./helpers/tar-fixtures.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalFetch = globalThis.fetch;

let workspaceDir: string;

function skillMarkdown(name: string, body: string): string {
  return `---
name: "${name}"
description: "A test skill."
---

${body}
`;
}

function writeInstalledSkill(skillId: string, name: string): void {
  const skillDir = join(workspaceDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMarkdown(name, "Old body."));
  writeFileSync(join(skillDir, "old.txt"), "keep me\n");
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "skills-install-staging-"));
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  mkdirSync(join(workspaceDir, "skills"), { recursive: true });
  mockExecSync.mockReset();
  mockExecSync.mockImplementation(() => {
    throw new Error("dependency install failed");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("staged skill installs", () => {
  test("catalog dependency failure does not leave a discoverable fresh install", async () => {
    const archive = gzipSync(
      makeTar([
        {
          name: "SKILL.md",
          content: skillMarkdown("Demo Skill", "New body."),
        },
        {
          name: "package.json",
          content: JSON.stringify({ dependencies: { example: "1.0.0" } }),
        },
      ]),
    );
    globalThis.fetch = mock(
      async () => new Response(archive),
    ) as unknown as typeof fetch;

    await expect(
      installSkillLocally(
        "demo-skill",
        {
          id: "demo-skill",
          name: "Demo Skill",
          description: "A test skill.",
        },
        false,
      ),
    ).rejects.toThrow("dependency install failed");

    expect(
      existsSync(join(workspaceDir, "skills", "demo-skill", "SKILL.md")),
    ).toBe(false);
    expect(loadSkillCatalog().some((skill) => skill.id === "demo-skill")).toBe(
      false,
    );
  });

  test("skills.sh overwrite dependency failure preserves the previous skill", async () => {
    writeInstalledSkill("demo-skill", "Old Demo Skill");

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/contents/skills/demo-skill")) {
        return new Response(
          JSON.stringify([
            {
              name: "SKILL.md",
              type: "file",
              download_url: "https://example.com/SKILL.md",
            },
            {
              name: "package.json",
              type: "file",
              download_url: "https://example.com/package.json",
            },
            {
              name: "new.txt",
              type: "file",
              download_url: "https://example.com/new.txt",
            },
          ]),
        );
      }
      if (url.endsWith("/SKILL.md")) {
        return new Response(skillMarkdown("New Demo Skill", "New body."));
      }
      if (url.endsWith("/package.json")) {
        return new Response(
          JSON.stringify({ dependencies: { example: "1.0.0" } }),
        );
      }
      if (url.endsWith("/new.txt")) {
        return new Response("new file\n");
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      installExternalSkill("owner", "repo", "demo-skill", true),
    ).rejects.toThrow("dependency install failed");

    const skillDir = join(workspaceDir, "skills", "demo-skill");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(
      "Old Demo Skill",
    );
    expect(readFileSync(join(skillDir, "old.txt"), "utf-8")).toBe("keep me\n");
    expect(existsSync(join(skillDir, "new.txt"))).toBe(false);
    expect(
      loadSkillCatalog().find((skill) => skill.id === "demo-skill")?.name,
    ).toBe("Old Demo Skill");
  });
});

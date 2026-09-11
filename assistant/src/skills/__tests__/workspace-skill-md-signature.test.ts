import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { readWorkspaceSkillMdSignature } from "../workspace-skill-md-signature.js";

const ROOT = mkdtempSync(join(tmpdir(), "skill-md-signature-"));

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

function writeSkill(id: string, body = "body"): string {
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  const skillMd = join(dir, "SKILL.md");
  writeFileSync(skillMd, `---\nname: ${id}\ndescription: ${id}\n---\n${body}\n`);
  return skillMd;
}

describe("readWorkspaceSkillMdSignature", () => {
  test("empty or missing skills dir is the empty signature", () => {
    expect(readWorkspaceSkillMdSignature(join(ROOT, "missing"))).toBe("");
    mkdirSync(ROOT, { recursive: true });
    expect(readWorkspaceSkillMdSignature(ROOT)).toBe("");
  });

  test("includes SKILL.md mtimes and ignores TOOLS.json", () => {
    const skillMd = writeSkill("alpha");
    const first = readWorkspaceSkillMdSignature(ROOT);
    expect(first).toMatch(/^alpha:\d+$/);

    writeFileSync(join(ROOT, "alpha", "TOOLS.json"), '{"version":1,"tools":[]}');
    expect(readWorkspaceSkillMdSignature(ROOT)).toBe(first);

    const later = new Date(Date.now() + 5_000);
    utimesSync(skillMd, later, later);
    expect(readWorkspaceSkillMdSignature(ROOT)).not.toBe(first);
  });

  test("add and remove skill directories change the signature", () => {
    writeSkill("alpha");
    const one = readWorkspaceSkillMdSignature(ROOT);
    writeSkill("bravo");
    const two = readWorkspaceSkillMdSignature(ROOT);
    expect(two).not.toBe(one);
    expect(two.split("\n")).toHaveLength(2);

    rmSync(join(ROOT, "bravo"), { recursive: true, force: true });
    expect(readWorkspaceSkillMdSignature(ROOT)).toBe(one);
  });

  test("directories without SKILL.md are omitted", () => {
    mkdirSync(join(ROOT, "not-a-skill"), { recursive: true });
    writeFileSync(join(ROOT, "README.md"), "nope");
    expect(readWorkspaceSkillMdSignature(ROOT)).toBe("");
  });
});

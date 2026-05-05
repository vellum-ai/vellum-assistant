import { describe, expect, test } from "bun:test";

import { loadSkillBySelector, loadSkillCatalog } from "../config/skills.js";

describe("system-storage-cleanup bundled skill", () => {
  test("is bundled without tools or inline command expansions", () => {
    const catalog = loadSkillCatalog();
    const skill = catalog.find(
      (candidate) => candidate.id === "system-storage-cleanup",
    );

    expect(skill).toBeDefined();
    expect(skill!.source).toBe("bundled");
    expect(skill!.bundled).toBe(true);
    expect(skill!.toolManifest).toBeUndefined();
    expect(skill!.inlineCommandExpansions).toBeUndefined();
  });

  test("loads by id and source-qualified selector with the cleanup safety contract", () => {
    const exactResult = loadSkillBySelector("system-storage-cleanup");
    expect(exactResult.error).toBeUndefined();
    expect(exactResult.skill?.id).toBe("system-storage-cleanup");
    expect(exactResult.skill?.source).toBe("bundled");

    const result = loadSkillBySelector("bundled:system-storage-cleanup");

    expect(result.error).toBeUndefined();
    expect(result.skill).toBeDefined();
    expect(result.skill!.id).toBe("system-storage-cleanup");
    expect(result.skill!.source).toBe("bundled");

    const body = result.skill!.body.toLowerCase();

    expect(body).toContain("normal work is suspended");
    expect(body).toContain("stay scoped to freeing storage");
    expect(body).toContain("prefer foreground inspection");
    expect(body).toContain("before any mutation");
    expect(body).toContain("ask for explicit approval before deleting");
    expect(body).toContain("target volume");
    expect(body).toContain("workspace path");
    expect(body).toContain("read-only `sqlite3` access");
    expect(body).toContain("never run ad hoc `delete`");
    expect(body).toContain("`vacuum`");
    expect(body).toContain("mutating sqlite command");

    for (const protectedText of [
      "credentials",
      "security material",
      "workspace database files",
      "config files",
      "backups",
      "backup keys",
      "memory graph nodes or segments",
      "`journal/`",
      "`data/reflections/`",
      "pkb files",
    ]) {
      expect(body).toContain(protectedText);
    }
  });

  test("only supports the bundled selector for the cleanup skill", () => {
    const result = loadSkillBySelector("bundled:app-builder");

    expect(result.skill).toBeUndefined();
    expect(result.errorCode).toBe("invalid_selector");
    expect(result.error).toContain("bundled:system-storage-cleanup");
  });
});

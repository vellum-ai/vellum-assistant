import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

// Control what getRepoSkillsDir() returns per test. Mocked before the module
// under test is imported so getLocalCategorySlugs() sees the override.
let repoSkillsDirOverride: string | undefined;

mock.module("../catalog-install.js", () => ({
  getRepoSkillsDir: () => repoSkillsDirOverride,
}));

const { getLocalCategorySlugs } = await import("../categories-cache.js");

// Repo-root `skills/` relative to this test file
// (assistant/src/skills/__tests__ -> repo root -> skills).
const REAL_SKILLS_DIR = join(import.meta.dir, "..", "..", "..", "..", "skills");

describe("getLocalCategorySlugs", () => {
  test("resolves slugs via getRepoSkillsDir when it is available", () => {
    repoSkillsDirOverride = REAL_SKILLS_DIR;
    const slugs = getLocalCategorySlugs();
    expect(slugs.has("development")).toBe(true);
    expect(slugs.has("system")).toBe(true);
  });

  test("falls back to the module-relative catalog when getRepoSkillsDir is undefined (Docker source-run)", () => {
    // Regression: in Docker mode the launcher runs `bun run src/index.ts`
    // without VELLUM_DEV, so getRepoSkillsDir() returns undefined. The reader
    // previously returned an empty set, which made normalizeMarketplaceCategory
    // treat every marketplace category as invalid and bucket all plugins under
    // System. The module-relative fallback must still resolve the bundled YAML.
    repoSkillsDirOverride = undefined;
    const slugs = getLocalCategorySlugs();
    expect(slugs.size).toBeGreaterThan(0);
    expect(slugs.has("development")).toBe(true);
    expect(slugs.has("system")).toBe(true);
  });
});

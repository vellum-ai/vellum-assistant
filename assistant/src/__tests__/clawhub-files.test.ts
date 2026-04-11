/**
 * Unit tests for `skills/clawhub-files.ts` — SkillFileProvider implementation
 * for clawhub-origin skills.
 *
 * Covers:
 *   - canHandle correctly distinguishes clawhub from skills.sh slugs
 *   - listFiles maps inspect result files to SkillFileEntry[]
 *   - listFiles returns null when inspect fails
 *   - readFileContent returns cached SKILL.md content without extra CLI call
 *   - readFileContent calls clawhubInspectFile for non-SKILL.md files
 *   - toSlimSkill maps inspect metadata to ClawhubSlimSkill
 *   - Cache hit avoids redundant inspect calls
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ClawhubInspectResult } from "../skills/clawhub.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Suppress logger output
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockInspectResult: { data?: ClawhubInspectResult; error?: string } = {};
let inspectCallCount = 0;
let mockInspectFileResult: string | null = null;
let inspectFileCallCount = 0;
let inspectFileCalls: Array<{ slug: string; filePath: string }> = [];

mock.module("../skills/clawhub.js", () => ({
  validateSlug: (slug: string): boolean => {
    return /^[a-zA-Z0-9]([a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?)?$/.test(
      slug,
    );
  },
  clawhubInspect: async (
    _slug: string,
  ): Promise<{ data?: ClawhubInspectResult; error?: string }> => {
    inspectCallCount++;
    return mockInspectResult;
  },
  clawhubInspectFile: async (
    slug: string,
    filePath: string,
  ): Promise<string | null> => {
    inspectFileCallCount++;
    inspectFileCalls.push({ slug, filePath });
    return mockInspectFileResult;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createClawhubProvider } from "../skills/clawhub-files.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The inspect cache is module-scoped in clawhub-files.ts and persists across
// tests. To avoid cross-test contamination, each test that calls async
// provider methods uses a UNIQUE slug so cache entries never collide.
let slugCounter = 0;
function uniqueSlug(base = "test-skill"): string {
  return `${base}-${++slugCounter}`;
}

function makeInspectData(
  slug: string,
  overrides?: Partial<ClawhubInspectResult>,
): ClawhubInspectResult {
  return {
    skill: { slug, displayName: "Test Skill", summary: "A test skill" },
    owner: { handle: "testauthor", displayName: "Test Author" },
    stats: { stars: 42, installs: 100, downloads: 200, versions: 3 },
    createdAt: 1700000000000,
    updatedAt: 1700100000000,
    latestVersion: { version: "1.0.0" },
    files: [
      { path: "SKILL.md", size: 512, contentType: "text/markdown" },
      { path: "tools/helper.ts", size: 1024, contentType: "text/typescript" },
      { path: "assets/icon.png", size: 2048, contentType: "image/png" },
    ],
    skillMdContent: "# Test Skill\n\nThis is the SKILL.md content.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mock state between tests (cache is handled via unique slugs)
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInspectResult = {};
  inspectCallCount = 0;
  mockInspectFileResult = null;
  inspectFileCallCount = 0;
  inspectFileCalls = [];
});

// ---------------------------------------------------------------------------
// canHandle
// ---------------------------------------------------------------------------

describe("canHandle", () => {
  const provider = createClawhubProvider();

  test("returns true for simple slug", () => {
    expect(provider.canHandle("my-skill")).toBe(true);
  });

  test("returns true for namespaced slug (author/skill)", () => {
    expect(provider.canHandle("author/my-skill")).toBe(true);
  });

  test("returns false for skills.sh slug (owner/repo/skill)", () => {
    expect(provider.canHandle("a/b/c")).toBe(false);
  });

  test("returns false for deeply nested slug", () => {
    expect(provider.canHandle("a/b/c/d")).toBe(false);
  });

  test("returns false for invalid slug", () => {
    expect(provider.canHandle("")).toBe(false);
  });

  test("returns false for slug starting with dot", () => {
    expect(provider.canHandle(".hidden")).toBe(false);
  });

  test("returns false for slug starting with hyphen", () => {
    expect(provider.canHandle("-dashed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe("listFiles", () => {
  test("maps inspect result files to SkillFileEntry[]", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("list-map");
    mockInspectResult = { data: makeInspectData(slug) };

    const entries = await provider.listFiles(slug);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(3);

    // Entries should be sorted by path
    expect(entries![0].path).toBe("SKILL.md");
    expect(entries![0].name).toBe("SKILL.md");
    expect(entries![0].size).toBe(512);
    expect(entries![0].isBinary).toBe(false);
    expect(entries![0].content).toBeNull(); // content is null in listings

    expect(entries![1].path).toBe("assets/icon.png");
    expect(entries![1].isBinary).toBe(true);

    expect(entries![2].path).toBe("tools/helper.ts");
    expect(entries![2].isBinary).toBe(false);
  });

  test("returns null when inspect fails", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("list-fail");
    mockInspectResult = { error: "Skill not found" };

    const entries = await provider.listFiles(slug);
    expect(entries).toBeNull();
  });

  test("returns null when inspect returns no files", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("list-nofiles");
    mockInspectResult = { data: makeInspectData(slug, { files: null }) };

    const entries = await provider.listFiles(slug);
    expect(entries).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readFileContent
// ---------------------------------------------------------------------------

describe("readFileContent", () => {
  test("returns cached SKILL.md content without extra CLI call", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("read-skillmd");
    mockInspectResult = { data: makeInspectData(slug) };

    // First call listFiles to populate the cache
    await provider.listFiles(slug);
    const initialCallCount = inspectCallCount;

    // Now read SKILL.md — should use cached skillMdContent
    const entry = await provider.readFileContent(slug, "SKILL.md");
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("SKILL.md");
    expect(entry!.name).toBe("SKILL.md");
    expect(entry!.content).toBe(
      "# Test Skill\n\nThis is the SKILL.md content.",
    );
    expect(entry!.isBinary).toBe(false);
    expect(entry!.mimeType).toBe("text/markdown");

    // No additional inspect call and no inspectFile call
    expect(inspectCallCount).toBe(initialCallCount);
    expect(inspectFileCallCount).toBe(0);
  });

  test("calls clawhubInspectFile for non-SKILL.md files", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("read-other");
    mockInspectResult = { data: makeInspectData(slug) };
    mockInspectFileResult = "export function helper() { return 42; }";

    // Populate cache first
    await provider.listFiles(slug);

    const entry = await provider.readFileContent(slug, "tools/helper.ts");
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("tools/helper.ts");
    expect(entry!.name).toBe("helper.ts");
    expect(entry!.content).toBe("export function helper() { return 42; }");
    expect(entry!.isBinary).toBe(false);

    expect(inspectFileCallCount).toBe(1);
    expect(inspectFileCalls[0].slug).toBe(slug);
    expect(inspectFileCalls[0].filePath).toBe("tools/helper.ts");
  });

  test("returns null when clawhubInspectFile fails", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("read-fail");
    mockInspectResult = { data: makeInspectData(slug) };
    mockInspectFileResult = null;

    await provider.listFiles(slug);

    const entry = await provider.readFileContent(slug, "tools/missing.ts");
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toSlimSkill
// ---------------------------------------------------------------------------

describe("toSlimSkill", () => {
  test("maps inspect metadata to ClawhubSlimSkill", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("slim-map");
    mockInspectResult = { data: makeInspectData(slug) };

    const slim = await provider.toSlimSkill(slug);
    expect(slim).not.toBeNull();
    expect(slim!.id).toBe(slug);
    expect(slim!.name).toBe("Test Skill");
    expect(slim!.description).toBe("A test skill");
    expect(slim!.kind).toBe("catalog");
    expect(slim!.status).toBe("available");
    expect(slim!.origin).toBe("clawhub");

    // Clawhub-specific fields
    const clawhub = slim as unknown as Record<string, unknown>;
    expect(clawhub.slug).toBe(slug);
    expect(clawhub.author).toBe("testauthor");
    expect(clawhub.stars).toBe(42);
    expect(clawhub.installs).toBe(100);
    expect(clawhub.reports).toBe(0);
  });

  test("returns null when inspect fails", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("slim-fail");
    mockInspectResult = { error: "Not found" };

    const slim = await provider.toSlimSkill(slug);
    expect(slim).toBeNull();
  });

  test("handles missing owner gracefully", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("slim-noowner");
    mockInspectResult = { data: makeInspectData(slug, { owner: null }) };

    const slim = await provider.toSlimSkill(slug);
    expect(slim).not.toBeNull();
    const clawhub = slim as unknown as Record<string, unknown>;
    expect(clawhub.author).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe("caching", () => {
  test("cache hit avoids redundant inspect calls", async () => {
    const provider = createClawhubProvider();
    const slug = uniqueSlug("cache-test");
    mockInspectResult = { data: makeInspectData(slug) };

    // First call — should trigger inspect
    await provider.listFiles(slug);
    expect(inspectCallCount).toBe(1);

    // Second call to toSlimSkill — should use cache
    await provider.toSlimSkill(slug);
    expect(inspectCallCount).toBe(1); // no additional call

    // Third call to listFiles — still cached
    await provider.listFiles(slug);
    expect(inspectCallCount).toBe(1);
  });
});

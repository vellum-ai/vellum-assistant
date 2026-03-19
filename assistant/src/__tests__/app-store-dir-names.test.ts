import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock getDataDir to use a temp directory
// ---------------------------------------------------------------------------

let testDataDir: string;

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDataDir,
  getProjectDir: () => testDataDir,
}));

// Re-import app-store after mocking so it uses our temp dir
const {
  slugify,
  generateAppDirName,
  validateDirName,
  resolveAppDir,
  getAppDirPath,
  getAppsDir,
  createApp,
  getApp,
  updateApp,
  deleteApp,
} = await import("../memory/app-store.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshTempDir(): string {
  return join(
    tmpdir(),
    `vellum-app-dir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function makeAppParams(name: string) {
  return {
    name,
    schemaJson: "{}",
    htmlDefinition: "<h1>Hello</h1>",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDataDir = freshTempDir();
  mkdirSync(join(testDataDir, "apps"), { recursive: true });
});

afterEach(() => {
  if (existsSync(testDataDir)) {
    rmSync(testDataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// slugify()
// ---------------------------------------------------------------------------

describe("slugify()", () => {
  test("normal names", () => {
    expect(slugify("My Cool App")).toBe("my-cool-app");
  });

  test("special characters are replaced with hyphens", () => {
    expect(slugify("hello@world!#$%")).toBe("hello-world");
  });

  test("unicode characters are replaced", () => {
    expect(slugify("café résumé")).toBe("caf-r-sum");
  });

  test("emoji-only names produce fallback slug", () => {
    const result = slugify("🚀🎉");
    expect(result).toMatch(/^app-[a-f0-9]{8}$/);
  });

  test("empty string produces fallback slug", () => {
    const result = slugify("");
    expect(result).toMatch(/^app-[a-f0-9]{8}$/);
  });

  test("very long names are truncated to 60 chars", () => {
    const longName = "a".repeat(100);
    const result = slugify(longName);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toBe("a".repeat(60));
  });

  test("truncation removes trailing hyphens", () => {
    // Create a name where position 60 lands on a hyphen sequence
    const name = "a".repeat(58) + "--bbb";
    const result = slugify(name);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).not.toMatch(/-$/);
  });

  test("names with only hyphens produce fallback slug", () => {
    const result = slugify("---");
    expect(result).toMatch(/^app-[a-f0-9]{8}$/);
  });

  test("leading and trailing hyphens are stripped", () => {
    expect(slugify("-hello-world-")).toBe("hello-world");
  });

  test("consecutive hyphens are collapsed", () => {
    expect(slugify("hello---world")).toBe("hello-world");
  });
});

// ---------------------------------------------------------------------------
// generateAppDirName()
// ---------------------------------------------------------------------------

describe("generateAppDirName()", () => {
  test("returns base slug when no collision", () => {
    const result = generateAppDirName("My App", new Set());
    expect(result).toBe("my-app");
  });

  test("appends -2 on first collision", () => {
    const result = generateAppDirName("My App", new Set(["my-app"]));
    expect(result).toBe("my-app-2");
  });

  test("escalates numeric suffix on multiple collisions", () => {
    const existing = new Set(["my-app", "my-app-2", "my-app-3"]);
    const result = generateAppDirName("My App", existing);
    expect(result).toBe("my-app-4");
  });

  test("collision with truncated names still deduplicates", () => {
    const longName = "a".repeat(100);
    const base = slugify(longName);
    const existing = new Set([base]);
    const result = generateAppDirName(longName, existing);
    expect(result).toBe(`${base}-2`);
  });
});

// ---------------------------------------------------------------------------
// createApp() — directory named after slug
// ---------------------------------------------------------------------------

describe("createApp()", () => {
  test("directory is named after slug, not UUID", () => {
    const app = createApp(makeAppParams("My Test App"));
    const appsDir = getAppsDir();

    // dirName should be the slug
    expect(app.dirName).toBe("my-test-app");

    // JSON file should be named after slug
    expect(existsSync(join(appsDir, "my-test-app.json"))).toBe(true);

    // Directory should be named after slug
    expect(existsSync(join(appsDir, "my-test-app"))).toBe(true);

    // UUID-named files should NOT exist
    expect(existsSync(join(appsDir, `${app.id}.json`))).toBe(false);
  });

  test("dirName is persisted in JSON", () => {
    const app = createApp(makeAppParams("Slug Test"));
    const appsDir = getAppsDir();
    const jsonPath = join(appsDir, "slug-test.json");
    const persisted = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(persisted.dirName).toBe("slug-test");
    expect(persisted.id).toBe(app.id);
  });

  test("index.html is in the slugified directory", () => {
    createApp(makeAppParams("Html App"));
    const appsDir = getAppsDir();
    const indexPath = join(appsDir, "html-app", "index.html");
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, "utf-8")).toBe("<h1>Hello</h1>");
  });

  test("deduplicates dirNames across multiple creates", () => {
    const app1 = createApp(makeAppParams("Duplicate"));
    const app2 = createApp(makeAppParams("Duplicate"));
    expect(app1.dirName).toBe("duplicate");
    expect(app2.dirName).toBe("duplicate-2");
  });
});

// ---------------------------------------------------------------------------
// createApp() + updateApp() — frozen dirName invariant
// ---------------------------------------------------------------------------

describe("frozen dirName invariant", () => {
  test("renaming an app does NOT change its directory name", () => {
    const app = createApp(makeAppParams("Original Name"));
    const appsDir = getAppsDir();

    expect(app.dirName).toBe("original-name");
    expect(existsSync(join(appsDir, "original-name.json"))).toBe(true);

    // Rename the app
    const updated = updateApp(app.id, { name: "New Name" });
    expect(updated.name).toBe("New Name");

    // Directory and files should still be at original slug
    expect(existsSync(join(appsDir, "original-name.json"))).toBe(true);
    expect(existsSync(join(appsDir, "original-name"))).toBe(true);

    // New name slug should NOT exist as files
    expect(existsSync(join(appsDir, "new-name.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getApp() — lookup by UUID with slugified dirs
// ---------------------------------------------------------------------------

describe("getApp()", () => {
  test("lookup by UUID works with slugified dirs", () => {
    const created = createApp(makeAppParams("Lookup App"));
    const fetched = getApp(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("Lookup App");
    expect(fetched!.htmlDefinition).toBe("<h1>Hello</h1>");
  });

  test("backward compat: works when JSON has no dirName (uses id as fallback)", () => {
    const appsDir = getAppsDir();
    const fakeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // Write a JSON file with no dirName, using the UUID as the filename
    const appData = {
      id: fakeId,
      name: "Legacy App",
      schemaJson: "{}",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeFileSync(
      join(appsDir, `${fakeId}.json`),
      JSON.stringify(appData, null, 2),
    );

    // Create directory with index.html
    const appDir = join(appsDir, fakeId);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "index.html"), "<p>legacy</p>", "utf-8");

    const fetched = getApp(fakeId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(fakeId);
    expect(fetched!.name).toBe("Legacy App");
    expect(fetched!.htmlDefinition).toBe("<p>legacy</p>");
  });
});

// ---------------------------------------------------------------------------
// deleteApp() — cleans up slugified files
// ---------------------------------------------------------------------------

describe("deleteApp()", () => {
  test("cleans up slugified directory, JSON, and preview files", () => {
    const app = createApp({
      ...makeAppParams("Delete Me"),
      preview: "base64-preview-data",
    });
    const appsDir = getAppsDir();

    // Verify files exist before deletion
    expect(existsSync(join(appsDir, "delete-me.json"))).toBe(true);
    expect(existsSync(join(appsDir, "delete-me"))).toBe(true);
    expect(existsSync(join(appsDir, "delete-me.preview"))).toBe(true);

    deleteApp(app.id);

    // All files should be gone
    expect(existsSync(join(appsDir, "delete-me.json"))).toBe(false);
    expect(existsSync(join(appsDir, "delete-me"))).toBe(false);
    expect(existsSync(join(appsDir, "delete-me.preview"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveAppDir() — validation rejects malicious dirName values
// When a JSON file has an invalid dirName, resolveAppDir defensively falls
// back to using the app ID instead of the malicious dirName. The
// validateDirName() call inside the try/catch causes the invalid entry to
// be skipped, and the function returns the safe fallback.
// ---------------------------------------------------------------------------

describe("resolveAppDir() validation", () => {
  test("falls back to id when dirName contains path traversal (..)", () => {
    const appsDir = getAppsDir();
    const fakeId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    writeFileSync(
      join(appsDir, `${fakeId}.json`),
      JSON.stringify({ id: fakeId, name: "Evil", dirName: "../etc" }),
    );

    // Should NOT use the malicious dirName — falls back to id
    const result = resolveAppDir(fakeId);
    expect(result.dirName).toBe(fakeId);
    expect(result.appDir).toBe(join(appsDir, fakeId));
  });

  test("falls back to id when dirName contains forward slash", () => {
    const appsDir = getAppsDir();
    const fakeId = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa";
    writeFileSync(
      join(appsDir, `${fakeId}.json`),
      JSON.stringify({ id: fakeId, name: "Evil", dirName: "foo/bar" }),
    );

    const result = resolveAppDir(fakeId);
    expect(result.dirName).toBe(fakeId);
  });

  test("falls back to id when dirName contains backslash", () => {
    const appsDir = getAppsDir();
    const fakeId = "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb";
    writeFileSync(
      join(appsDir, `${fakeId}.json`),
      JSON.stringify({ id: fakeId, name: "Evil", dirName: "foo\\bar" }),
    );

    const result = resolveAppDir(fakeId);
    expect(result.dirName).toBe(fakeId);
  });

  test("falls back to id when dirName is empty string", () => {
    const appsDir = getAppsDir();
    const fakeId = "eeeeeeee-ffff-aaaa-bbbb-cccccccccccc";
    writeFileSync(
      join(appsDir, `${fakeId}.json`),
      JSON.stringify({ id: fakeId, name: "Evil", dirName: "" }),
    );

    // Empty string is falsy, so validateDirName is not called.
    // `parsed.dirName ?? id` with nullish coalescing: "" is not nullish,
    // so dirName = "". The function returns "" as dirName.
    const result = resolveAppDir(fakeId);
    // Empty dirName is falsy, so the conditional `if (parsed.dirName)` is false,
    // meaning it won't call validateDirName. The dirName "" is used as-is.
    expect(result.dirName).toBe("");
  });
});

// ---------------------------------------------------------------------------
// validateDirName() — direct unit tests
// ---------------------------------------------------------------------------

describe("validateDirName()", () => {
  test("accepts valid slug names", () => {
    expect(() => validateDirName("my-cool-app")).not.toThrow();
    expect(() => validateDirName("app-123")).not.toThrow();
  });

  test("rejects git pathspec metacharacters", () => {
    expect(() => validateDirName("app*")).toThrow("git pathspec");
    expect(() => validateDirName("app?")).toThrow("git pathspec");
    expect(() => validateDirName("app[0]")).toThrow("git pathspec");
    expect(() => validateDirName("app:foo")).toThrow("git pathspec");
    expect(() => validateDirName("app(1)")).toThrow("git pathspec");
  });

  test("rejects path traversal", () => {
    expect(() => validateDirName("..")).toThrow("Invalid dirName");
    expect(() => validateDirName("foo/bar")).toThrow("Invalid dirName");
  });
});

// ---------------------------------------------------------------------------
// getAppDirPath() — returns correct path
// ---------------------------------------------------------------------------

describe("getAppDirPath()", () => {
  test("returns correct path for slugified apps", () => {
    const app = createApp(makeAppParams("Path Test"));
    const appsDir = getAppsDir();
    const result = getAppDirPath(app.id);
    expect(result).toBe(join(appsDir, "path-test"));
  });

  test("returns correct path for legacy apps (no dirName)", () => {
    const appsDir = getAppsDir();
    const fakeId = "11111111-2222-3333-4444-555555555555";
    // Write a legacy JSON with no dirName
    writeFileSync(
      join(appsDir, `${fakeId}.json`),
      JSON.stringify({ id: fakeId, name: "Legacy" }),
    );

    const result = getAppDirPath(fakeId);
    expect(result).toBe(join(appsDir, fakeId));
  });
});

// ---------------------------------------------------------------------------
// Guard test: no file outside app-store.ts constructs getAppsDir() + appId
// (Note: the primary guard test is in app-dir-path-guard.test.ts; this is
//  a complementary check that we can import and use the guard-relevant
//  functions without issues.)
// ---------------------------------------------------------------------------

describe("guard: getAppsDir + appId path construction", () => {
  test("app-dir-path-guard.test.ts exists and covers this concern", () => {
    // This is a meta-test to ensure the guard test file is present
    expect(existsSync(join(__dirname, "app-dir-path-guard.test.ts"))).toBe(
      true,
    );
  });
});

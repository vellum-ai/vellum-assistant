import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

// Create a temp workspace dir for each test
const testWorkspace = join(tmpdir(), `gmail-prefs-test-${Date.now()}`);
mkdirSync(join(testWorkspace, "data"), { recursive: true });

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => testWorkspace,
}));

const {
  loadPreferences,
  addToBlocklist,
  addToSafelist,
  removeFromBlocklist,
  removeFromSafelist,
} = await import("../config/bundled-skills/gmail/tools/gmail-preferences.js");

describe("gmail preferences", () => {
  afterEach(() => {
    // Clean up the prefs file between tests
    try {
      rmSync(join(testWorkspace, "data", "gmail-preferences.json"));
    } catch {
      // OK if doesn't exist
    }
  });

  test("returns empty lists when no prefs file exists", () => {
    const prefs = loadPreferences();
    expect(prefs.blocklist).toEqual([]);
    expect(prefs.safelist).toEqual([]);
  });

  test("addToBlocklist persists and deduplicates emails", () => {
    addToBlocklist(["spam@example.com", "junk@test.com"]);
    addToBlocklist(["spam@example.com", "more@test.com"]);

    const prefs = loadPreferences();
    expect(prefs.blocklist).toContain("spam@example.com");
    expect(prefs.blocklist).toContain("junk@test.com");
    expect(prefs.blocklist).toContain("more@test.com");
    expect(
      prefs.blocklist.filter((e) => e === "spam@example.com"),
    ).toHaveLength(1);
  });

  test("addToSafelist persists and deduplicates emails", () => {
    addToSafelist(["keep@example.com"]);
    addToSafelist(["keep@example.com", "also@keep.com"]);

    const prefs = loadPreferences();
    expect(prefs.safelist).toContain("keep@example.com");
    expect(prefs.safelist).toContain("also@keep.com");
    expect(prefs.safelist.filter((e) => e === "keep@example.com")).toHaveLength(
      1,
    );
  });

  test("blocklisting removes from safelist", () => {
    addToSafelist(["sender@example.com"]);
    expect(loadPreferences().safelist).toContain("sender@example.com");

    addToBlocklist(["sender@example.com"]);
    const prefs = loadPreferences();
    expect(prefs.blocklist).toContain("sender@example.com");
    expect(prefs.safelist).not.toContain("sender@example.com");
  });

  test("safelisting removes from blocklist", () => {
    addToBlocklist(["sender@example.com"]);
    expect(loadPreferences().blocklist).toContain("sender@example.com");

    addToSafelist(["sender@example.com"]);
    const prefs = loadPreferences();
    expect(prefs.safelist).toContain("sender@example.com");
    expect(prefs.blocklist).not.toContain("sender@example.com");
  });

  test("removeFromBlocklist works", () => {
    addToBlocklist(["a@test.com", "b@test.com", "c@test.com"]);
    removeFromBlocklist(["b@test.com"]);

    const prefs = loadPreferences();
    expect(prefs.blocklist).toContain("a@test.com");
    expect(prefs.blocklist).not.toContain("b@test.com");
    expect(prefs.blocklist).toContain("c@test.com");
  });

  test("removeFromSafelist works", () => {
    addToSafelist(["a@test.com", "b@test.com"]);
    removeFromSafelist(["a@test.com"]);

    const prefs = loadPreferences();
    expect(prefs.safelist).not.toContain("a@test.com");
    expect(prefs.safelist).toContain("b@test.com");
  });

  test("normalizes emails to lowercase", () => {
    addToBlocklist(["SPAM@Example.COM"]);
    const prefs = loadPreferences();
    expect(prefs.blocklist).toContain("spam@example.com");
  });

  test("handles corrupted prefs file gracefully", () => {
    writeFileSync(
      join(testWorkspace, "data", "gmail-preferences.json"),
      "not json",
    );
    const prefs = loadPreferences();
    expect(prefs.blocklist).toEqual([]);
    expect(prefs.safelist).toEqual([]);
  });
});

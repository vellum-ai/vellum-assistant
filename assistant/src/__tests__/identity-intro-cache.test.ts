/**
 * Unit tests for the identity intro cache (identity-intro-cache.ts).
 *
 * Validates TTL-based expiration, content-hash-based invalidation when
 * workspace identity files change, and round-trip get/set behavior.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

// Suppress logger output
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// In-memory checkpoint store
const checkpointStore = new Map<string, string>();

mock.module("../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpointStore.set(key, value);
  },
}));

// Simulated workspace file contents
const workspaceFiles: Record<string, string> = {};

mock.module("../util/platform.js", () => ({
  getWorkspacePromptPath: (name: string) => `/mock/workspace/${name}`,
}));

mock.module("node:fs", () => ({
  existsSync: (path: string) => {
    const name = path.split("/").pop() ?? "";
    return name in workspaceFiles;
  },
  readFileSync: (path: string, _encoding: string) => {
    const name = path.split("/").pop() ?? "";
    if (name in workspaceFiles) return workspaceFiles[name];
    throw new Error(`ENOENT: ${path}`);
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  computeIdentityContentHash,
  getCachedIntro,
  setCachedIntro,
} from "../runtime/routes/identity-intro-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  checkpointStore.clear();
  for (const key of Object.keys(workspaceFiles)) {
    delete workspaceFiles[key];
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("identity intro cache", () => {
  test("returns null when cache is empty", () => {
    expect(getCachedIntro()).toBeNull();
  });

  test("round-trip: set then get returns cached text", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    workspaceFiles["SOUL.md"] = "Be playful.";
    workspaceFiles["USER.md"] = "The user likes coffee.";

    setCachedIntro("Hey, I'm Atlas.");
    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.text).toBe("Hey, I'm Atlas.");
  });

  test("returns null when cache is expired (TTL exceeded)", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";

    setCachedIntro("Hello!");

    // Manually set the timestamp to 5 hours ago
    const fiveHoursAgo = String(Date.now() - 5 * 60 * 60 * 1000);
    checkpointStore.set("identity:intro:cached_at", fiveHoursAgo);

    expect(getCachedIntro()).toBeNull();
  });

  test("returns cached text when within TTL (3 hours ago)", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";

    setCachedIntro("Hello!");

    // Set timestamp to 3 hours ago (within 4-hour TTL)
    const threeHoursAgo = String(Date.now() - 3 * 60 * 60 * 1000);
    checkpointStore.set("identity:intro:cached_at", threeHoursAgo);

    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.text).toBe("Hello!");
  });

  test("busts cache when IDENTITY.md changes", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    setCachedIntro("I'm Atlas!");

    // Change IDENTITY.md
    workspaceFiles["IDENTITY.md"] = "- **Name:** Nova";

    expect(getCachedIntro()).toBeNull();
  });

  test("busts cache when SOUL.md changes", () => {
    workspaceFiles["SOUL.md"] = "Be playful.";
    setCachedIntro("Hey there!");

    // Change SOUL.md
    workspaceFiles["SOUL.md"] = "Be serious and formal.";

    expect(getCachedIntro()).toBeNull();
  });

  test("busts cache when USER.md changes", () => {
    workspaceFiles["USER.md"] = "Likes coffee.";
    setCachedIntro("Good morning!");

    // Change USER.md
    workspaceFiles["USER.md"] = "Likes tea.";

    expect(getCachedIntro()).toBeNull();
  });

  test("cache survives when files are unchanged", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    workspaceFiles["SOUL.md"] = "Be chill.";
    workspaceFiles["USER.md"] = "Likes sunsets.";

    setCachedIntro("Atlas here.");

    // Read twice — both should return the cached value
    expect(getCachedIntro()?.text).toBe("Atlas here.");
    expect(getCachedIntro()?.text).toBe("Atlas here.");
  });

  test("computeIdentityContentHash is deterministic", () => {
    workspaceFiles["IDENTITY.md"] = "test";
    workspaceFiles["SOUL.md"] = "test2";
    workspaceFiles["USER.md"] = "test3";

    const hash1 = computeIdentityContentHash();
    const hash2 = computeIdentityContentHash();
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  test("computeIdentityContentHash changes when file content changes", () => {
    workspaceFiles["IDENTITY.md"] = "v1";
    const hash1 = computeIdentityContentHash();

    workspaceFiles["IDENTITY.md"] = "v2";
    const hash2 = computeIdentityContentHash();

    expect(hash1).not.toBe(hash2);
  });

  test("handles missing workspace files gracefully", () => {
    // No files exist — should still work (empty content hashed)
    setCachedIntro("Hello!");
    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.text).toBe("Hello!");
  });

  test("returns null when text checkpoint is missing", () => {
    checkpointStore.set("identity:intro:content_hash", "abc");
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));
    // Missing text — should return null
    expect(getCachedIntro()).toBeNull();
  });

  test("returns null when hash checkpoint is missing", () => {
    checkpointStore.set("identity:intro:text", "Hello");
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));
    // Missing hash — should return null
    expect(getCachedIntro()).toBeNull();
  });

  test("returns null when timestamp checkpoint is missing", () => {
    checkpointStore.set("identity:intro:text", "Hello");
    checkpointStore.set("identity:intro:content_hash", "abc");
    // Missing timestamp — should return null
    expect(getCachedIntro()).toBeNull();
  });
});

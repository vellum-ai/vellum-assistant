/**
 * Unit tests for the identity intro cache (identity-intro-cache.ts).
 *
 * Validates TTL-based expiration, content-hash-based invalidation when
 * workspace identity files or the guardian persona content change, and
 * round-trip get/set behavior.
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

// Mocked guardian persona — mutable so tests can change it and verify cache
// invalidation based on the per-user persona file content.
let guardianPersonaContent: string | null = null;

mock.module("../prompts/persona-resolver.js", () => ({
  resolveGuardianPersona: () => guardianPersonaContent,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  computeIdentityContentHash,
  getCachedIntro,
  parseGreetingsSection,
  readWorkspaceGreetings,
  readWorkspaceIdentityIntro,
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
  guardianPersonaContent = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("identity intro cache", () => {
  test("reads explicit intro from IDENTITY.md before SOUL.md", () => {
    workspaceFiles["IDENTITY.md"] = [
      "# Identity",
      "",
      "## Identity Intro",
      "Nova here.",
    ].join("\n");
    workspaceFiles["SOUL.md"] = [
      "# Soul",
      "",
      "## Identity Intro",
      "Soul fallback.",
    ].join("\n");

    expect(readWorkspaceIdentityIntro()).toBe("Nova here.");
  });

  test("falls back to SOUL.md identity intro for legacy workspaces", () => {
    workspaceFiles["SOUL.md"] = [
      "# Soul",
      "",
      "## Identity Intro",
      "Soul fallback.",
    ].join("\n");

    expect(readWorkspaceIdentityIntro()).toBe("Soul fallback.");
  });

  test("returns null when cache is empty", () => {
    expect(getCachedIntro()).toBeNull();
  });

  test("round-trip: set then get returns cached greetings array", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    workspaceFiles["SOUL.md"] = "Be playful.";
    guardianPersonaContent = "The user likes coffee.";

    setCachedIntro(["Hey, I'm Atlas.", "What's up?"]);
    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Hey, I'm Atlas.", "What's up?"]);
  });

  test("returns null when cache is expired (TTL exceeded)", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";

    setCachedIntro(["Hello!"]);

    // Manually set the timestamp to 5 hours ago
    const fiveHoursAgo = String(Date.now() - 5 * 60 * 60 * 1000);
    checkpointStore.set("identity:intro:cached_at", fiveHoursAgo);

    expect(getCachedIntro()).toBeNull();
  });

  test("returns cached greetings when within TTL (3 hours ago)", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";

    setCachedIntro(["Hello!"]);

    // Set timestamp to 3 hours ago (within 4-hour TTL)
    const threeHoursAgo = String(Date.now() - 3 * 60 * 60 * 1000);
    checkpointStore.set("identity:intro:cached_at", threeHoursAgo);

    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Hello!"]);
  });

  test("busts cache when IDENTITY.md changes", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    setCachedIntro(["I'm Atlas!"]);

    // Change IDENTITY.md
    workspaceFiles["IDENTITY.md"] = "- **Name:** Nova";

    expect(getCachedIntro()).toBeNull();
  });

  test("busts cache when SOUL.md changes", () => {
    workspaceFiles["SOUL.md"] = "Be playful.";
    setCachedIntro(["Hey there!"]);

    // Change SOUL.md
    workspaceFiles["SOUL.md"] = "Be serious and formal.";

    expect(getCachedIntro()).toBeNull();
  });

  test("busts cache when guardian persona content changes", () => {
    guardianPersonaContent = "Likes coffee.";
    setCachedIntro(["Good morning!"]);

    // Change guardian persona (e.g. user edited users/<slug>.md)
    guardianPersonaContent = "Likes tea.";

    expect(getCachedIntro()).toBeNull();
  });

  test("cache remains valid when guardian persona is unchanged", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    workspaceFiles["SOUL.md"] = "Be chill.";
    guardianPersonaContent = "Likes sunsets.";

    setCachedIntro(["Atlas here.", "Hey friend."]);

    expect(getCachedIntro()?.greetings).toEqual(["Atlas here.", "Hey friend."]);
    expect(getCachedIntro()?.greetings).toEqual(["Atlas here.", "Hey friend."]);
  });

  test("computeIdentityContentHash is deterministic", () => {
    workspaceFiles["IDENTITY.md"] = "test";
    workspaceFiles["SOUL.md"] = "test2";
    guardianPersonaContent = "test3";

    const hash1 = computeIdentityContentHash();
    const hash2 = computeIdentityContentHash();
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  test("computeIdentityContentHash changes when guardian persona changes", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    workspaceFiles["SOUL.md"] = "Be playful.";
    guardianPersonaContent = "Likes coffee.";
    const hash1 = computeIdentityContentHash();

    guardianPersonaContent = "Likes tea.";
    const hash2 = computeIdentityContentHash();

    expect(hash1).not.toBe(hash2);
  });

  test("computeIdentityContentHash handles null guardian persona", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    guardianPersonaContent = null;

    const hash = computeIdentityContentHash();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
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
    setCachedIntro(["Hello!"]);
    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Hello!"]);
  });

  test("handles legacy single-string cache value", () => {
    // Simulate a cache entry written by an older daemon version
    const hash = computeIdentityContentHash();
    checkpointStore.set("identity:intro:greetings", "Legacy greeting");
    checkpointStore.set("identity:intro:content_hash", hash);
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));

    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Legacy greeting"]);
  });

  test("returns null when greetings checkpoint is missing", () => {
    checkpointStore.set("identity:intro:content_hash", "abc");
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));
    expect(getCachedIntro()).toBeNull();
  });

  test("returns null when hash checkpoint is missing", () => {
    checkpointStore.set("identity:intro:greetings", '["Hello"]');
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));
    expect(getCachedIntro()).toBeNull();
  });

  test("returns null when timestamp checkpoint is missing", () => {
    checkpointStore.set("identity:intro:greetings", '["Hello"]');
    checkpointStore.set("identity:intro:content_hash", "abc");
    expect(getCachedIntro()).toBeNull();
  });
});

describe("parseGreetingsSection", () => {
  test("parses bullet list from ## Greetings section", () => {
    const content = [
      "# Soul",
      "",
      "## Greetings",
      "- Hey there, friend!",
      "- What's on your mind?",
      "- Ready to roll!",
      "",
      "## Other Section",
      "Some other content.",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "Hey there, friend!",
      "What's on your mind?",
      "Ready to roll!",
    ]);
  });

  test("handles asterisk bullets", () => {
    const content = [
      "## Greetings",
      "* Hello!",
      "* Hi there.",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual(["Hello!", "Hi there."]);
  });

  test("returns null when section is missing", () => {
    const content = [
      "# Soul",
      "## Personality",
      "Be friendly.",
    ].join("\n");

    expect(parseGreetingsSection(content)).toBeNull();
  });

  test("returns null when section is empty", () => {
    const content = [
      "## Greetings",
      "",
      "## Next Section",
    ].join("\n");

    expect(parseGreetingsSection(content)).toBeNull();
  });

  test("ignores non-bullet lines in section", () => {
    const content = [
      "## Greetings",
      "Some intro text that's not a bullet",
      "- Actual greeting",
      "Another non-bullet line",
      "- Second greeting",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "Actual greeting",
      "Second greeting",
    ]);
  });

  test("stops at next heading", () => {
    const content = [
      "## Greetings",
      "- First",
      "- Second",
      "### Sub-heading",
      "- Should not appear",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual(["First", "Second"]);
  });
});

describe("readWorkspaceGreetings", () => {
  test("reads greetings from SOUL.md", () => {
    workspaceFiles["SOUL.md"] = [
      "# Soul",
      "## Greetings",
      "- Hey!",
      "- What's up?",
    ].join("\n");

    expect(readWorkspaceGreetings()).toEqual(["Hey!", "What's up?"]);
  });

  test("returns null when SOUL.md has no greetings section", () => {
    workspaceFiles["SOUL.md"] = "# Soul\nBe friendly.";
    expect(readWorkspaceGreetings()).toBeNull();
  });

  test("returns null when SOUL.md does not exist", () => {
    expect(readWorkspaceGreetings()).toBeNull();
  });
});

/**
 * Unit tests for the identity intro cache (identity-intro-cache.ts).
 *
 * Validates TTL-based expiration, round-trip get/set behavior, and parsing
 * workspace-authored greeting sections.
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
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

    setCachedIntro(["Hey, I'm Atlas.", "What's up?"]);
    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Hey, I'm Atlas.", "What's up?"]);
  });

  test("returns null when cache is expired (TTL exceeded)", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";

    setCachedIntro(["Hello!"]);

    const fourHoursAndOneMinuteAgo = String(
      Date.now() - (4 * 60 + 1) * 60 * 1000,
    );
    checkpointStore.set("identity:intro:cached_at", fourHoursAndOneMinuteAgo);

    expect(getCachedIntro()).toBeNull();
  });

  test("returns cached greetings when within TTL (3 hours 59 minutes ago)", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";

    setCachedIntro(["Hello!"]);

    const threeHoursAndFiftyNineMinutesAgo = String(
      Date.now() - (3 * 60 + 59) * 60 * 1000,
    );
    checkpointStore.set(
      "identity:intro:cached_at",
      threeHoursAndFiftyNineMinutesAgo,
    );

    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Hello!"]);
  });

  test("keeps cached greetings when IDENTITY.md changes", () => {
    workspaceFiles["IDENTITY.md"] = "- **Name:** Atlas";
    setCachedIntro(["I'm Atlas!"]);

    workspaceFiles["IDENTITY.md"] = "- **Name:** Nova";

    expect(getCachedIntro()?.greetings).toEqual(["I'm Atlas!"]);
  });

  test("keeps cached greetings when SOUL.md changes", () => {
    workspaceFiles["SOUL.md"] = "Be playful.";
    setCachedIntro(["Hey there!"]);

    workspaceFiles["SOUL.md"] = "Be serious and formal.";

    expect(getCachedIntro()?.greetings).toEqual(["Hey there!"]);
  });

  test("handles missing workspace files gracefully", () => {
    // No files exist — should still work.
    setCachedIntro(["Hello!"]);
    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Hello!"]);
  });

  test("handles legacy single-string cache value", () => {
    // Simulate a cache entry written by an older daemon version
    checkpointStore.set("identity:intro:greetings", "Legacy greeting");
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));

    const cached = getCachedIntro();
    expect(cached).not.toBeNull();
    expect(cached!.greetings).toEqual(["Legacy greeting"]);
  });

  test("returns null when greetings checkpoint is missing", () => {
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));
    expect(getCachedIntro()).toBeNull();
  });

  test("returns null when timestamp checkpoint is missing", () => {
    checkpointStore.set("identity:intro:greetings", '["Hello"]');
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
    const content = ["## Greetings", "* Hello!", "* Hi there."].join("\n");

    expect(parseGreetingsSection(content)).toEqual(["Hello!", "Hi there."]);
  });

  test("handles plus and numbered bullets", () => {
    const content = [
      "## Greetings",
      "+ Welcome back.",
      "1. Ready when you are.",
      "2) What are we building today?",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "Welcome back.",
      "Ready when you are.",
      "What are we building today?",
    ]);
  });

  test("only starts at a level-two Greetings heading", () => {
    const content = [
      "# Greetings",
      "- Not the section contract.",
      "",
      "## Greetings",
      "- The real greeting.",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual(["The real greeting."]);
  });

  test("returns null when section is missing", () => {
    const content = ["# Soul", "## Personality", "Be friendly."].join("\n");

    expect(parseGreetingsSection(content)).toBeNull();
  });

  test("returns null when section is empty", () => {
    const content = ["## Greetings", "", "## Next Section"].join("\n");

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

  test("allows nested headings and stops at the next same-or-higher heading", () => {
    const content = [
      "## Greetings",
      "- First",
      "- Second",
      "### Sub-heading",
      "- Third",
      "## Other Section",
      "- Should not appear",
    ].join("\n");

    expect(parseGreetingsSection(content)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
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

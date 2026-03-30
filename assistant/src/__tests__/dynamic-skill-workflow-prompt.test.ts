import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

import { mock } from "bun:test";

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

const { buildSystemPrompt } = await import("../prompts/system-prompt.js");
const { _setOverridesForTesting } =
  await import("../config/assistant-feature-flags.js");

describe("Dynamic Skill Authoring Workflow moved to tool descriptions", () => {
  beforeEach(() => {
    _setOverridesForTesting({
      browser: true,
    });
  });

  afterEach(() => {
    _setOverridesForTesting({});
  });

  test("system prompt no longer contains Dynamic Skill Authoring section", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Dynamic Skill Authoring Workflow");
    expect(result).not.toContain("### Community Skills Discovery");
  });

  test("prompt still includes available skills catalog when skills exist", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(join(skillsDir, "test-skill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "test-skill", "SKILL.md"),
      '---\nname: "Test Skill"\ndescription: "For testing."\n---\n\nDo testing.\n',
    );
    writeFileSync(join(skillsDir, "SKILLS.md"), "- test-skill\n");
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");

    const result = buildSystemPrompt();
    expect(result).toContain("## Available Skills");
    expect(result).toContain("**test-skill**");
  });

  test("prompt is additive with IDENTITY/SOUL/USER files", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity here");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul here");
    writeFileSync(join(TEST_DIR, "USER.md"), "User here");

    const result = buildSystemPrompt();
    expect(result).toContain("Identity here");
    expect(result).toContain("Soul here");
    expect(result).toContain("User here");
  });

  test("browser skill has activation hints in skills catalog instead of dedicated section", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    const result = buildSystemPrompt();
    // Browser routing moved from dedicated section to inline hints in catalog bullet
    expect(result).not.toContain("Browser Skill Prerequisite");
    expect(result).toContain("**browser**");
    expect(result).toContain("Load first if you need browser_* tools");
  });
});

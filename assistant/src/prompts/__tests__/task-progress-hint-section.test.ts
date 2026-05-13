/**
 * Tests for the task_progress_hint workspace system prompt section.
 *
 * Verifies that 02-task-progress-hint.md exists as a bundled template and
 * renders unconditionally into the system prompt output — no `enabled`
 * frontmatter gating, no options dependency.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const mockLoadedConfig: Record<string, unknown> = {};

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
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
  loadConfig: () => mockLoadedConfig,
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

const { buildSystemPrompt, ensurePromptFiles, SYSTEM_PROMPT_CACHE_BOUNDARY } =
  await import("../system-prompt.js");

const TEMPLATE_PATH = join(
  import.meta.dirname ?? __dirname,
  "..",
  "templates",
  "system",
  "02-task-progress-hint.md",
);

describe("task_progress_hint workspace section", () => {
  beforeEach(() => {
    // Seed template files into the test workspace — mirrors daemon startup.
    ensurePromptFiles();
  });

  test("template file exists at the expected bundled path", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  test("buildSystemPrompt() includes task_progress content", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("task_progress");
  });

  test("renders unconditionally — no options required", () => {
    const result = buildSystemPrompt(undefined);
    expect(result).toContain("task_progress_hint");
  });

  test("renders regardless of options passed", () => {
    const withBackground = buildSystemPrompt({
      isBackgroundConversation: true,
    });
    const withoutBackground = buildSystemPrompt({
      isBackgroundConversation: false,
    });
    const withExcludePrefix = buildSystemPrompt({
      excludeCustomPrefix: true,
    });

    expect(withBackground).toContain("task_progress_hint");
    expect(withoutBackground).toContain("task_progress_hint");
    expect(withExcludePrefix).toContain("task_progress_hint");
  });

  test("section lives in the static (cached) block before SYSTEM_PROMPT_CACHE_BOUNDARY", () => {
    const result = buildSystemPrompt();
    const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);
    const staticBlock = result.slice(0, boundaryIdx);
    expect(staticBlock).toContain("task_progress_hint");
  });
});

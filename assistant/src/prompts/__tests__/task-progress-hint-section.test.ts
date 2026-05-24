/**
 * Tests for the task_progress hint in the 01-parallel-tool-calls workspace
 * system prompt section.
 *
 * Verifies that the task_progress guidance renders unconditionally in the
 * system prompt — no `enabled` frontmatter gating, no options dependency.
 */

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

const { buildSystemPrompt, ensurePromptFiles } = await import(
  "../system-prompt.js"
);

describe("task_progress hint in parallel-tool-calls section", () => {
  beforeEach(() => {
    ensurePromptFiles();
  });

  test("buildSystemPrompt() includes task_progress guidance", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("task_progress");
    expect(result).toContain("No exceptions");
  });

  test("renders unconditionally — no options required", () => {
    const result = buildSystemPrompt(undefined);
    expect(result).toContain("task_progress");
  });

  test("renders regardless of options passed", () => {
    const withClientFlag = buildSystemPrompt({ hasNoClient: true });
    const withoutClientFlag = buildSystemPrompt({ hasNoClient: false });
    const withExcludePrefix = buildSystemPrompt({
      excludeCustomPrefix: true,
    });

    expect(withClientFlag).toContain("task_progress");
    expect(withoutClientFlag).toContain("task_progress");
    expect(withExcludePrefix).toContain("task_progress");
  });

});

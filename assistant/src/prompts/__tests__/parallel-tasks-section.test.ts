/**
 * Tests for the `01-parallel-tasks` system prompt section: it renders
 * unconditionally (no flag, no options dependency), sits beside
 * `01-parallel-tool-calls`, and scopes the guidance to independent tasks so a
 * single small request stays inline.
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

const { buildSystemPrompt, ensurePromptFiles } =
  await import("../system-prompt.js");
const { BUNDLED_SYSTEM_SECTIONS } =
  await import("../templates/system-sections.js");

const HEADING = "Run Independent Tasks in Parallel";

describe("parallel-tasks system prompt section", () => {
  beforeEach(() => {
    ensurePromptFiles();
  });

  test("is in the bundled section list next to the parallel-tool-calls section", () => {
    const ids = BUNDLED_SYSTEM_SECTIONS.map((section) => section.id);
    expect(ids).toContain("01-parallel-tasks");
    expect(ids).toContain("01-parallel-tool-calls");
  });

  test("renders unconditionally, with no options required", () => {
    expect(buildSystemPrompt()).toContain(HEADING);
    expect(buildSystemPrompt({ hasNoClient: true })).toContain(HEADING);
  });

  test("delegates only independent tasks and keeps small requests inline", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("several independent things at once");
    expect(prompt).toContain("subagent");
    expect(prompt).toContain("Keep small, quick requests inline");
  });
});

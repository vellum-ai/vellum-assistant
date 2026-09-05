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

  test("renders immediately before the parallel-tool-calls section", () => {
    // The renderer sorts section ids, so adjacency in the rendered prompt is
    // adjacency in the sorted id list, not in the declaration order.
    const sortedIds = BUNDLED_SYSTEM_SECTIONS.map((section) => section.id)
      .slice()
      .sort();
    const index = sortedIds.indexOf("01-parallel-tasks");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(sortedIds[index + 1]).toBe("01-parallel-tool-calls");
  });

  test("renders by default, with no options required", () => {
    expect(buildSystemPrompt()).toContain(HEADING);
    expect(buildSystemPrompt({ hasNoClient: true })).toContain(HEADING);
    expect(buildSystemPrompt({ canSpawnSubagents: true })).toContain(HEADING);
  });

  test("renders off for a turn that cannot spawn subagents", () => {
    // The shape a tool-disabled `/v1/btw` side-chain and a restricted-tool
    // workflow leaf build: telling them to delegate would make them defer work
    // they can only do inline.
    expect(buildSystemPrompt({ canSpawnSubagents: false })).not.toContain(
      HEADING,
    );
    // The rest of the prompt is untouched by the opt-out.
    expect(buildSystemPrompt({ canSpawnSubagents: false })).toContain(
      "<use_parallel_tool_calls>",
    );
  });

  test("delegates only independent tasks and keeps small requests inline", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("several independent things at once");
    expect(prompt).toContain("subagent");
    expect(prompt).toContain("Keep small, quick requests inline");
  });

  test("keeps approval-gated work on the assistant's own turn", () => {
    // A subagent runs non-interactive, so an operation that needs the user's
    // approval is denied there rather than prompting.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("may need the user's approval on your own turn");
  });
});

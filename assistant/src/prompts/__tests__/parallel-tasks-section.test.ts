/**
 * Tests for the `01-parallel-tasks` system prompt section: it sits beside
 * `01-parallel-tool-calls`, scopes the guidance to independent tasks so a
 * single small request stays inline, and renders only for a turn that can act
 * on it - one that can spawn subagents AND whose reply is not delivered to an
 * external channel.
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
type ChannelCapabilities =
  import("../../daemon/conversation-runtime-assembly.js").ChannelCapabilities;

const HEADING = "Run Independent Tasks in Parallel";

function channel(id: string): ChannelCapabilities {
  return {
    channel: id,
    dashboardCapable: false,
    supportsDynamicUi: false,
    supportsVoiceInput: false,
  };
}

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

  test("renders for a turn that can spawn subagents", () => {
    expect(buildSystemPrompt({ canSpawnSubagents: true })).toContain(HEADING);
    expect(
      buildSystemPrompt({ canSpawnSubagents: true, hasNoClient: true }),
    ).toContain(HEADING);
    // Every first-party client folds onto the `vellum` channel.
    expect(
      buildSystemPrompt({
        canSpawnSubagents: true,
        channelCapabilities: channel("vellum"),
      }),
    ).toContain(HEADING);
  });

  test("renders off for a channel-delivered turn", () => {
    // A subagent's terminal summary is injected through the conversation's
    // event sink, which app clients read and a channel does not, so a
    // delegated answer would never reach the person who asked for it.
    for (const id of ["slack", "telegram", "email", "plugin"]) {
      const prompt = buildSystemPrompt({
        canSpawnSubagents: true,
        channelCapabilities: channel(id),
      });
      expect(prompt).not.toContain(HEADING);
      expect(prompt).toContain("<use_parallel_tool_calls>");
    }
  });

  test("renders off unless the turn states it can spawn", () => {
    // Absent means no: a prompt built outside a turn (a tool-disabled
    // side-chain, a one-shot generator) never carries guidance it cannot act
    // on. The live turn answers from its resolved tool surface.
    for (const options of [
      undefined,
      { hasNoClient: true },
      { canSpawnSubagents: false },
    ]) {
      expect(buildSystemPrompt(options)).not.toContain(HEADING);
      // The rest of the prompt is untouched either way.
      expect(buildSystemPrompt(options)).toContain("<use_parallel_tool_calls>");
    }
  });

  test("delegates only independent tasks and keeps small requests inline", () => {
    const prompt = buildSystemPrompt({ canSpawnSubagents: true });
    expect(prompt).toContain("several independent things at once");
    expect(prompt).toContain("subagent");
    expect(prompt).toContain("Keep small, quick requests inline");
  });

  test("keeps approval-gated work on the assistant's own turn", () => {
    // A subagent runs non-interactive, so an operation that needs the user's
    // approval is denied there rather than prompting.
    const prompt = buildSystemPrompt({ canSpawnSubagents: true });
    expect(prompt).toContain("may need the user's approval on your own turn");
  });
});

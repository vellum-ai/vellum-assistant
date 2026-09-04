/**
 * Tests for the `01-send-user-message` system prompt section: it renders only
 * for a turn whose user-facing text goes through the tool, so every other
 * prompt build (subagents, calls, live-voice, background workers) is unchanged.
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

const HEADING = "Your Plain Text Is Private";

describe("send_user_message system prompt section", () => {
  beforeEach(() => {
    ensurePromptFiles();
  });

  test("is absent by default", () => {
    expect(buildSystemPrompt()).not.toContain(HEADING);
    expect(buildSystemPrompt({ hasNoClient: true })).not.toContain(HEADING);
  });

  test("is absent when the option is explicitly false", () => {
    expect(buildSystemPrompt({ sendUserMessageTool: false })).not.toContain(
      HEADING,
    );
  });

  test("renders when the turn routes its text through the tool", () => {
    const prompt = buildSystemPrompt({ sendUserMessageTool: true });
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain("private scratchpad");
    expect(prompt).toContain("send_user_message");
    // The section states only what a tool description cannot: that plain text
    // is invisible, and the "talk before you work" override. How to write a
    // message belongs to the tool description, so none of it repeats here.
    expect(prompt).not.toContain("1 to 3 plain sentences");
    expect(prompt).not.toContain("no technical narration");
  });
});

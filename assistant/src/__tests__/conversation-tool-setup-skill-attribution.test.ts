/**
 * Tests for skill attribution in the skill_execute interception of
 * createToolExecutor (conversation-tool-setup.ts): skill-routed dispatches
 * must carry the owning skill's id on the ToolContext handed to the
 * executor, while direct tool calls must not.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";

import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import { RiskLevel } from "../permissions/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import {
  installConversationToolSetupMocks,
  makeToolSetupContext,
} from "./conversation-tool-setup-test-helpers.js";

installConversationToolSetupMocks();

import { createToolExecutor } from "../daemon/conversation-tool-setup.js";
import { registerSkillTools, unregisterSkillTools } from "../tools/registry.js";

const SKILL_ID = "attribution-test-skill";
const SKILL_TOOL_NAME = "attribution_test_tool";

const skillTool: Tool = {
  name: SKILL_TOOL_NAME,
  description: "skill tool for attribution tests",
  category: "skill",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "sandbox",
  input_schema: { type: "object", properties: {} },
  execute: async () => ({ content: "ok", isError: false }),
};

registerSkillTools(SKILL_ID, [skillTool]);
afterAll(() => unregisterSkillTools(SKILL_ID));

/** Fake ToolExecutor that captures the context of each execute() call. */
function makeCapturingExecutor() {
  const calls: Array<{ name: string; context: ToolContext }> = [];
  const executor = {
    execute: async (
      name: string,
      _input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> => {
      calls.push({ name, context });
      return { content: "ok", isError: false };
    },
  };
  return { executor: executor as unknown as ToolExecutor, calls };
}

const noopPrompter = {
  prompt: mock(async () => ({ decision: "allow" as const })),
} as unknown as PermissionPrompter;
const noopSecretPrompter = {
  prompt: mock(async () => ({ cancelled: true })),
} as unknown as SecretPrompter;

function makeToolFn(executor: ToolExecutor) {
  return createToolExecutor(
    executor,
    noopPrompter,
    noopSecretPrompter,
    makeToolSetupContext(),
    () => {},
  );
}

describe("conversation-tool-setup skill attribution", () => {
  test("skill_execute dispatch sets the owning skill id on the executor context", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor);

    const result = await toolFn("skill_execute", {
      tool: SKILL_TOOL_NAME,
      input: {},
      activity: "testing",
    });

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(SKILL_TOOL_NAME);
    expect(calls[0].context.skillId).toBe(SKILL_ID);
  });

  test("skill_execute with a non-skill-owned tool leaves skillId unset", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor);

    await toolFn("skill_execute", {
      tool: "file_read",
      input: { path: "/tmp/a" },
      activity: "testing",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("file_read");
    expect(calls[0].context.skillId).toBeUndefined();
  });

  test("direct tool calls leave skillId unset", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor);

    await toolFn("file_read", { path: "/tmp/a" });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("file_read");
    expect(calls[0].context.skillId).toBeUndefined();
  });
});

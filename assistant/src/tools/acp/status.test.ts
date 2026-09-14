/**
 * Tests for the `acp_status` tool's projection of session state.
 *
 * The state the manager tracks feeds three surfaces with different budgets:
 * the HTTP route, the SSE picker, and this tool, whose output is spent on
 * LLM context. Only the fields an agent can act on belong here.
 */

import { describe, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../../acp/types.js";
import type { ToolContext } from "../types.js";

const RUNNING_STATE: AcpSessionState = {
  id: "acp-1",
  agentId: "claude",
  acpSessionId: "proto-1",
  parentConversationId: "conv-1",
  status: "running",
  startedAt: 1234,
  task: "refactor the parser",
  model: "claude-opus-4-5",
  availableModels: [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus", description: "Most capable" },
  ],
};

let statusResult: AcpSessionState | AcpSessionState[] = RUNNING_STATE;

const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({ getStatus: () => statusResult }),
}));

const { executeAcpStatus } = await import("./status.js");

const context = {
  conversationId: "conv-1",
  workingDir: "/tmp",
} as unknown as ToolContext;

describe("executeAcpStatus", () => {
  test("a single session reports its model but not the picker", async () => {
    statusResult = RUNNING_STATE;

    const result = await executeAcpStatus({ acp_session_id: "acp-1" }, context);

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    expect(payload).toEqual({
      id: "acp-1",
      agentId: "claude",
      acpSessionId: "proto-1",
      parentConversationId: "conv-1",
      status: "running",
      startedAt: 1234,
      task: "refactor the parser",
      model: "claude-opus-4-5",
    });
    expect(result.content).not.toContain("Most capable");
  });

  test("the listing drops the picker from every entry", async () => {
    statusResult = [
      RUNNING_STATE,
      { ...RUNNING_STATE, id: "acp-2", model: "sonnet" },
    ];

    const result = await executeAcpStatus({}, context);

    const payload = JSON.parse(result.content) as Array<
      Record<string, unknown>
    >;
    expect(payload).toHaveLength(2);
    expect(payload.map((entry) => entry.model)).toEqual([
      "claude-opus-4-5",
      "sonnet",
    ]);
    for (const entry of payload) {
      expect(entry).not.toHaveProperty("availableModels");
    }
  });

  test("an empty listing says so rather than rendering an empty array", async () => {
    statusResult = [];

    const result = await executeAcpStatus({}, context);

    expect(result.content).toBe("No ACP sessions found.");
    expect(result.isError).toBe(false);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../../acp/types.js";
import type { ToolContext } from "../types.js";

interface SteerCall {
  acpSessionId: string;
  instruction: string;
}

const steerCalls: SteerCall[] = [];
const defaultSteer = (acpSessionId: string, instruction: string) => {
  steerCalls.push({ acpSessionId, instruction });
  return Promise.resolve();
};
let steerImpl: (acpSessionId: string, instruction: string) => Promise<void> =
  defaultSteer;

// Most-recent live session returned for a conversation, or null when none.
let liveSession: AcpSessionState | null = null;
const liveLookups: string[] = [];

// Spread the real module's exports so transitive importers that pull other
// names from `../../acp/index.js` still resolve at parse time. Bun's
// `mock.module` is process-global and returns *exactly* the factory's keys.
const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({
    steer: (acpSessionId: string, instruction: string) =>
      steerImpl(acpSessionId, instruction),
    getLiveSessionForConversation: (conversationId: string) => {
      liveLookups.push(conversationId);
      return liveSession;
    },
  }),
}));

const { executeAcpContinue } = await import("./continue.js");

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
  };
}

function makeLive(id: string): AcpSessionState {
  return {
    id,
    agentId: "claude",
    acpSessionId: `proto-${id}`,
    parentConversationId: "conv-test",
    status: "idle",
    startedAt: 1,
  };
}

beforeEach(() => {
  steerCalls.length = 0;
  liveLookups.length = 0;
  steerImpl = defaultSteer;
  liveSession = null;
});

describe("executeAcpContinue", () => {
  test("explicit acp_session_id: reaches the same session via manager.steer", async () => {
    const result = await executeAcpContinue(
      { acp_session_id: "acp-123", instruction: "now also add tests" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    // Did not resolve via conversation — explicit id wins.
    expect(liveLookups).toEqual([]);
    expect(steerCalls).toEqual([
      { acpSessionId: "acp-123", instruction: "now also add tests" },
    ]);

    const parsed = JSON.parse(result.content as string);
    expect(parsed.acpSessionId).toBe("acp-123");
    expect(parsed.status).toBe("continued");
  });

  test("resolves the conversation's live session when acp_session_id is omitted", async () => {
    liveSession = makeLive("acp-live");

    const result = await executeAcpContinue(
      { instruction: "keep going" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(liveLookups).toEqual(["conv-test"]);
    expect(steerCalls).toEqual([
      { acpSessionId: "acp-live", instruction: "keep going" },
    ]);
  });

  test("missing instruction returns isError", async () => {
    const result = await executeAcpContinue(
      { acp_session_id: "acp-123" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"instruction" is required');
    expect(steerCalls).toEqual([]);
  });

  test("no live session for the conversation errors cleanly", async () => {
    liveSession = null;

    const result = await executeAcpContinue(
      { instruction: "keep going" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No live ACP session");
    expect(steerCalls).toEqual([]);
  });

  test("closed/non-existent session: manager.steer rejection surfaces cleanly", async () => {
    steerImpl = () =>
      Promise.reject(new Error('ACP session "acp-x" not found'));

    const result = await executeAcpContinue(
      { acp_session_id: "acp-x", instruction: "continue" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not continue ACP session "acp-x"');
    expect(result.content).toContain("not found");
  });
});

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

// In-memory session state keyed by id, used by the explicit-id path's
// getStatus lookup. Absent → getStatus throws (unknown session), mirroring the
// real manager. Default status for a seeded entry is `idle`.
const statesById = new Map<string, AcpSessionState>();

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
    getStatus: (id?: string) => {
      if (id === undefined) return Array.from(statesById.values());
      const state = statesById.get(id);
      if (!state) throw new Error(`ACP session "${id}" not found`);
      return state;
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

function makeLive(
  id: string,
  status: AcpSessionState["status"] = "idle",
): AcpSessionState {
  return {
    id,
    agentId: "claude",
    acpSessionId: `proto-${id}`,
    parentConversationId: "conv-test",
    status,
    startedAt: 1,
  };
}

/** Seed an in-memory state for the explicit-id getStatus path. */
function seedState(id: string, status: AcpSessionState["status"] = "idle") {
  statesById.set(id, makeLive(id, status));
}

beforeEach(() => {
  steerCalls.length = 0;
  liveLookups.length = 0;
  steerImpl = defaultSteer;
  liveSession = null;
  statesById.clear();
});

describe("executeAcpContinue", () => {
  test("explicit acp_session_id: reaches the same session via manager.steer", async () => {
    seedState("acp-123", "idle");
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

  test("explicit unknown session id: getStatus miss surfaces cleanly without steering", async () => {
    // Not seeded → getStatus throws → clean isError, and we never call steer
    // (so a non-existent id can't fall through to the cancel path).
    const result = await executeAcpContinue(
      { acp_session_id: "acp-x", instruction: "continue" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not continue ACP session "acp-x"');
    expect(result.content).toContain("not found or not reusable");
    expect(steerCalls).toEqual([]);
  });

  test("closed/non-reusable session: manager.steer rejection surfaces cleanly", async () => {
    // Session resolves as idle via getStatus but steer rejects (e.g. the
    // adapter tore down between the status read and the steer).
    seedState("acp-x", "idle");
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

  test("explicit running session: refuses to steer (would cancel the in-flight prompt)", async () => {
    seedState("acp-busy", "running");

    const result = await executeAcpContinue(
      { acp_session_id: "acp-busy", instruction: "also do X" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("is busy");
    expect(result.content).toContain("running");
    // Critically, steer was NOT called — the in-flight prompt is preserved.
    expect(steerCalls).toEqual([]);
  });

  test("conversation-resolved running session: refuses to steer", async () => {
    liveSession = makeLive("acp-live-busy", "running");

    const result = await executeAcpContinue(
      { instruction: "also do X" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("is busy");
    expect(steerCalls).toEqual([]);
  });

  test("idle session resolved from the conversation continues normally", async () => {
    liveSession = makeLive("acp-live-idle", "idle");

    const result = await executeAcpContinue(
      { instruction: "keep going" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(steerCalls).toEqual([
      { acpSessionId: "acp-live-idle", instruction: "keep going" },
    ]);
  });
});

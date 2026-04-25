import { beforeEach, describe, expect, mock, test } from "bun:test";

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

// Spread the real module's exports so transitive importers that pull other
// names from `../../acp/index.js` (e.g. `broadcastToAllClients` from the
// HTTP route layer) still resolve at parse time. Bun's `mock.module` is
// process-global and returns *exactly* the keys the factory returns.
const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({
    steer: (acpSessionId: string, instruction: string) =>
      steerImpl(acpSessionId, instruction),
  }),
}));

const { executeAcpSteer } = await import("./steer.js");

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
  };
}

beforeEach(() => {
  steerCalls.length = 0;
  steerImpl = defaultSteer;
});

describe("executeAcpSteer", () => {
  test("happy path: returns steered status and forwards args to manager", async () => {
    const result = await executeAcpSteer(
      { acp_session_id: "acp-123", instruction: "stop, do X instead" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(steerCalls).toEqual([
      { acpSessionId: "acp-123", instruction: "stop, do X instead" },
    ]);

    const parsed = JSON.parse(result.content as string);
    expect(parsed).toEqual({
      acpSessionId: "acp-123",
      status: "steered",
      message: "Interrupted in-flight prompt; new instruction is now running.",
    });
  });

  test("missing instruction returns isError", async () => {
    const result = await executeAcpSteer(
      { acp_session_id: "acp-123" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"instruction" is required');
    expect(steerCalls).toEqual([]);
  });

  test("missing acp_session_id returns isError", async () => {
    const result = await executeAcpSteer(
      { instruction: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"acp_session_id" is required');
    expect(steerCalls).toEqual([]);
  });

  test("manager.steer throwing 'session not found' surfaces the error", async () => {
    steerImpl = () =>
      Promise.reject(new Error('ACP session "acp-x" not found'));

    const result = await executeAcpSteer(
      { acp_session_id: "acp-x", instruction: "redirect" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not steer ACP session "acp-x"');
    expect(result.content).toContain("not found");
  });
});

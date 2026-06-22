import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../types.js";

interface SteerCall {
  acpSessionId: string;
  instruction: string;
}

// Direct steer (no connected client -> no resume fallback).
const steerCalls: SteerCall[] = [];
const defaultSteer = (acpSessionId: string, instruction: string) => {
  steerCalls.push({ acpSessionId, instruction });
  return Promise.resolve();
};
let steerImpl: (acpSessionId: string, instruction: string) => Promise<void> =
  defaultSteer;

// steerOrResume (connected client path).
const steerOrResumeCalls: Array<SteerCall & { send: unknown }> = [];
let steerOrResumeImpl: (
  acpSessionId: string,
  instruction: string,
) => Promise<{ resumed: boolean }> = async () => ({ resumed: false });

// Spread the real module's exports so transitive importers that pull other
// names from `../../acp/index.js` still resolve at parse time. Bun's `mock.module` is
// process-global and returns *exactly* the keys the factory returns.
const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({
    steer: (acpSessionId: string, instruction: string) =>
      steerImpl(acpSessionId, instruction),
    steerOrResume: (
      acpSessionId: string,
      instruction: string,
      send: unknown,
    ) => {
      steerOrResumeCalls.push({ acpSessionId, instruction, send });
      return steerOrResumeImpl(acpSessionId, instruction);
    },
  }),
}));

const { executeAcpSteer } = await import("./steer.js");

function makeContext(opts?: { withClient?: boolean }): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
    ...(opts?.withClient ? { sendToClient: () => {} } : {}),
  } as ToolContext;
}

beforeEach(() => {
  steerCalls.length = 0;
  steerOrResumeCalls.length = 0;
  steerImpl = defaultSteer;
  steerOrResumeImpl = async () => ({ resumed: false });
});

describe("executeAcpSteer", () => {
  test("happy path: returns steered status and forwards args to steerOrResume", async () => {
    const result = await executeAcpSteer(
      { acp_session_id: "acp-123", instruction: "stop, do X instead" },
      makeContext({ withClient: true }),
    );

    expect(result.isError).toBe(false);
    expect(steerOrResumeCalls).toHaveLength(1);
    expect(steerOrResumeCalls[0]).toMatchObject({
      acpSessionId: "acp-123",
      instruction: "stop, do X instead",
    });
    expect(typeof steerOrResumeCalls[0]!.send).toBe("function");
    expect(steerCalls).toEqual([]);

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
    expect(steerOrResumeCalls).toEqual([]);
  });

  test("missing acp_session_id returns isError", async () => {
    const result = await executeAcpSteer(
      { instruction: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"acp_session_id" is required');
    expect(steerCalls).toEqual([]);
    expect(steerOrResumeCalls).toEqual([]);
  });

  test("no connected client: steers directly and never resumes", async () => {
    const result = await executeAcpSteer(
      { acp_session_id: "acp-direct", instruction: "redirect" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(steerCalls).toEqual([
      { acpSessionId: "acp-direct", instruction: "redirect" },
    ]);
    expect(steerOrResumeCalls).toEqual([]);
  });

  test("'session not found' without a connected client surfaces the error", async () => {
    steerImpl = () =>
      Promise.reject(new Error('ACP session "acp-x" not found'));

    const result = await executeAcpSteer(
      { acp_session_id: "acp-x", instruction: "redirect" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not steer ACP session "acp-x"');
    expect(result.content).toContain("not found");
    expect(steerOrResumeCalls).toEqual([]);
  });

  test("resumed session reports the resumed flag and message", async () => {
    steerOrResumeImpl = async () => ({ resumed: true });

    const result = await executeAcpSteer(
      { acp_session_id: "acp-gone", instruction: "keep going" },
      makeContext({ withClient: true }),
    );

    expect(result.isError).toBe(false);
    expect(steerOrResumeCalls).toHaveLength(1);

    const parsed = JSON.parse(result.content as string);
    expect(parsed).toEqual({
      acpSessionId: "acp-gone",
      status: "steered",
      resumed: true,
      message:
        "Session was resumed from history; new instruction is now running.",
    });
  });

  test("resume failure returns its actionable error message", async () => {
    steerOrResumeImpl = () =>
      Promise.reject(
        new Error(
          'ACP session "acp-legacy" was recorded before resume support (no working directory persisted) and cannot be resumed. Spawn a new session instead.',
        ),
      );

    const result = await executeAcpSteer(
      { acp_session_id: "acp-legacy", instruction: "more work" },
      makeContext({ withClient: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Could not steer ACP session "acp-legacy"',
    );
    expect(result.content).toContain("recorded before resume support");
  });

  test("plain steer errors surface unchanged", async () => {
    steerOrResumeImpl = () =>
      Promise.reject(
        new Error(
          'ACP session "acp-init" is not running (status: initializing)',
        ),
      );

    const result = await executeAcpSteer(
      { acp_session_id: "acp-init", instruction: "redirect" },
      makeContext({ withClient: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("is not running");
  });
});

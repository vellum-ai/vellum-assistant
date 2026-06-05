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

const resumeCalls: Array<{ acpSessionId: string; send: unknown }> = [];
let resumeImpl: (acpSessionId: string) => Promise<void> = () =>
  Promise.resolve();

// Spread the real module's exports so transitive importers that pull other
// names from `../../acp/index.js` still resolve at parse time. Bun's `mock.module` is
// process-global and returns *exactly* the keys the factory returns.
const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({
    steer: (acpSessionId: string, instruction: string) =>
      steerImpl(acpSessionId, instruction),
    resumeFromHistory: (acpSessionId: string, send: unknown) => {
      resumeCalls.push({ acpSessionId, send });
      return resumeImpl(acpSessionId);
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
  resumeCalls.length = 0;
  steerImpl = defaultSteer;
  resumeImpl = () => Promise.resolve();
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
    expect(resumeCalls).toEqual([]);

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
    expect(resumeCalls).toEqual([]);
  });

  test("'session not found' with a client: resumes from history and retries the steer", async () => {
    let firstCall = true;
    steerImpl = (acpSessionId, instruction) => {
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error('ACP session "acp-gone" not found'));
      }
      return defaultSteer(acpSessionId, instruction);
    };

    const result = await executeAcpSteer(
      { acp_session_id: "acp-gone", instruction: "keep going" },
      makeContext({ withClient: true }),
    );

    expect(result.isError).toBe(false);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]!.acpSessionId).toBe("acp-gone");
    expect(typeof resumeCalls[0]!.send).toBe("function");
    // The retry went through after the resume.
    expect(steerCalls).toEqual([
      { acpSessionId: "acp-gone", instruction: "keep going" },
    ]);

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
    steerImpl = () =>
      Promise.reject(new Error('ACP session "acp-legacy" not found'));
    resumeImpl = () =>
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
    expect(steerCalls).toEqual([]);
  });

  test("non-not-found steer errors never trigger a resume", async () => {
    steerImpl = () =>
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
    expect(resumeCalls).toEqual([]);
  });
});

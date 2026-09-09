import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  AcpModelNotOfferedError,
  AcpModelSelectionUnsupportedError,
  AcpSessionNotFoundError,
} from "../../acp/session-manager.js";
import type { AcpSessionState } from "../../acp/types.js";
import type { ToolContext } from "../types.js";

interface SetModelCall {
  acpSessionId: string;
  model: string;
}

const setModelCalls: SetModelCall[] = [];
let setModelImpl: (
  acpSessionId: string,
  model: string,
) => Promise<unknown> = async (acpSessionId, model) =>
  sessionState(acpSessionId, model);

function sessionState(acpSessionId: string, model?: string): AcpSessionState {
  return {
    id: "sess-1",
    agentId: "claude",
    acpSessionId,
    parentConversationId: "conv-test",
    status: "running",
    startedAt: 0,
    ...(model ? { model } : {}),
  } as AcpSessionState;
}

// Spread the real module's exports so transitive importers that pull other
// names from `../../acp/index.js` still resolve at parse time. Bun's
// `mock.module` is process-global and returns *exactly* the keys the factory
// returns.
const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({
    setModel: (acpSessionId: string, model: string) => {
      setModelCalls.push({ acpSessionId, model });
      return setModelImpl(acpSessionId, model);
    },
  }),
}));

const { executeAcpSetModel } = await import("./set-model.js");

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
  } as ToolContext;
}

beforeEach(() => {
  setModelCalls.length = 0;
  setModelImpl = async (acpSessionId, model) =>
    sessionState(acpSessionId, model);
});

describe("executeAcpSetModel", () => {
  test("happy path: forwards the switch and reports what the adapter now runs", async () => {
    setModelImpl = async (acpSessionId) => sessionState(acpSessionId, "opus");

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-123", model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(setModelCalls).toEqual([{ acpSessionId: "acp-123", model: "opus" }]);
    expect(JSON.parse(result.content as string)).toEqual({
      acpSessionId: "acp-123",
      model: "opus",
      status: "model_set",
      message:
        "The agent applies it from the next turn; a prompt already running finishes on the model it started on.",
    });
  });

  test("a state with no reported model falls back to the requested one", async () => {
    setModelImpl = async (acpSessionId) => sessionState(acpSessionId);

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-123", model: "sonnet" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string).model).toBe("sonnet");
  });

  test("trims the requested model before handing it to the manager", async () => {
    await executeAcpSetModel(
      { acp_session_id: "acp-123", model: "  opus  " },
      makeContext(),
    );

    expect(setModelCalls).toEqual([{ acpSessionId: "acp-123", model: "opus" }]);
  });

  test("unknown or ended session reads as not running", async () => {
    setModelImpl = () =>
      Promise.reject(new AcpSessionNotFoundError("acp-gone"));

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-gone", model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('ACP session "acp-gone" is not running');
    expect(result.content).toContain("Spawn a new session");
  });

  test("an agent with no selector is reported as such", async () => {
    setModelImpl = () =>
      Promise.reject(new AcpModelSelectionUnsupportedError("acp-plain"));

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-plain", model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("advertises no model selector");
  });

  test("a model the agent does not offer relays the available list", async () => {
    setModelImpl = () =>
      Promise.reject(
        new AcpModelNotOfferedError("acp-123", "gpt-5", ["opus", "sonnet"]),
      );

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-123", model: "gpt-5" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not offer model "gpt-5"');
    expect(result.content).toContain("Available: opus, sonnet");
    // A typed rejection names the model, so it does not send the assistant
    // off to re-check a session that is fine.
    expect(result.content).not.toContain("acp_status");
  });

  test("an adapter rejection is relayed without claiming the session is healthy", async () => {
    setModelImpl = () =>
      Promise.reject(new Error("model is not available on this plan"));

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-123", model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Could not switch the model on ACP session "acp-123"',
    );
    expect(result.content).toContain("model is not available on this plan");
    expect(result.content).toContain("acp_status");
  });

  test("a transport failure is not reported as a refusal", async () => {
    // The adapter call failing is indistinguishable here from the adapter
    // answering "no", so neither may claim the session is still usable.
    setModelImpl = () =>
      Promise.reject(new Error("agent process exited before responding"));

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-dead", model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Could not switch the model on ACP session "acp-dead"',
    );
    expect(result.content).toContain("agent process exited before responding");
    expect(result.content).toContain("acp_status");
    expect(result.content).not.toContain("refused");
  });

  test("a non-Error rejection still renders its text", async () => {
    setModelImpl = () => Promise.reject("rpc timeout");

    const result = await executeAcpSetModel(
      { acp_session_id: "acp-123", model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("rpc timeout");
    expect(result.content).not.toContain("[object Object]");
  });

  test("missing acp_session_id returns isError", async () => {
    const result = await executeAcpSetModel({ model: "opus" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"acp_session_id" is required');
    expect(setModelCalls).toEqual([]);
  });

  test("explicit null model reads as missing", async () => {
    const result = await executeAcpSetModel(
      { acp_session_id: "acp-123", model: null },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"model" is required');
    expect(setModelCalls).toEqual([]);
  });

  test("rejects a non-string acp_session_id", async () => {
    const result = await executeAcpSetModel(
      { acp_session_id: 42, model: "opus" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "acp_set_model"');
    expect(setModelCalls).toEqual([]);
  });
});

/**
 * The worker → daemon notify is fire-and-forget: it hands a conversation id to
 * the daemon over IPC and must never surface a failure to the caller (a busy or
 * down daemon just leaves the anchor stale until the client repairs it). IPC is
 * mocked — no daemon process is spawned.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface CapturedCall {
  method: string;
  params?: Record<string, unknown>;
  options?: unknown;
}

const calls: CapturedCall[] = [];
let nextResult: { ok: boolean; error?: string } = { ok: true };
let shouldThrow = false;

mock.module("../../ipc/cli-client.js", () => ({
  cliIpcCall: async (
    method: string,
    params?: Record<string, unknown>,
    options?: unknown,
  ) => {
    calls.push({ method, params, options });
    if (shouldThrow) {
      throw new Error("connection refused");
    }
    return nextResult;
  },
}));

import {
  NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD,
  notifyDaemonConversationPersisted,
} from "./worker-daemon-notify.js";

describe("notifyDaemonConversationPersisted", () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = { ok: true };
    shouldThrow = false;
  });

  test("hands the conversation id to the daemon over the shared IPC method", async () => {
    await notifyDaemonConversationPersisted("conv-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD);
    expect(calls[0]!.params).toEqual({ body: { conversationId: "conv-1" } });
  });

  test("swallows a failed IPC result (best-effort, no throw)", async () => {
    nextResult = { ok: false, error: "daemon unreachable" };

    const result = await notifyDaemonConversationPersisted("conv-1");
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("swallows a thrown IPC error (best-effort, no throw)", async () => {
    shouldThrow = true;

    const result = await notifyDaemonConversationPersisted("conv-1");
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

/**
 * Tests the side-process → daemon publish forwarder. It calls the daemon's
 * `/events/publish` IPC route with the event envelope, and is best-effort: a
 * transport failure is logged, never thrown.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEventEnvelope } from "../../api/index.js";

interface IpcCall {
  method: string;
  params?: Record<string, unknown>;
}
const ipcCalls: IpcCall[] = [];
let ipcResult: { ok: boolean; error?: string } = { ok: true };

mock.module("../cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return ipcResult;
  },
}));

const { EVENTS_PUBLISH_IPC_METHOD, forwardEventPublishToDaemon } =
  await import("../events-publish-client.js");

function event(): AssistantEventEnvelope {
  return {
    id: "e1",
    conversationId: "c1",
    emittedAt: "2026-01-01T00:00:00.000Z",
    message: {
      type: "sync_changed",
    } as unknown as AssistantEventEnvelope["message"],
  };
}

beforeEach(() => {
  ipcCalls.length = 0;
  ipcResult = { ok: true };
});

describe("forwardEventPublishToDaemon", () => {
  test("calls the /events/publish route with the event (and options when present)", async () => {
    await forwardEventPublishToDaemon(event(), { excludeClientId: "tab-1" });
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe(EVENTS_PUBLISH_IPC_METHOD);
    expect(ipcCalls[0].params).toEqual({
      body: { event: event(), options: { excludeClientId: "tab-1" } },
    });
  });

  test("passes undefined options through when none are given", async () => {
    await forwardEventPublishToDaemon(event(), undefined);
    expect(ipcCalls[0].params).toEqual({
      body: { event: event(), options: undefined },
    });
  });

  test("does not throw when the IPC transport fails", async () => {
    ipcResult = { ok: false, error: "connect failed" };
    await expect(
      forwardEventPublishToDaemon(event(), undefined),
    ).resolves.toBeUndefined();
  });
});

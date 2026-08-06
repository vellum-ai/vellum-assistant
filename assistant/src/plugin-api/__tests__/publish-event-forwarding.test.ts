/**
 * Tests the daemon-vs-side-process routing in the event-hub facade (exercised
 * through {@link publishEvent}).
 *
 * In the daemon the event publishes on the local hub; in a side process (where
 * seq stamping is disabled) the local hub reaches no SSE subscriber, so the
 * event is forwarded to the daemon over IPC instead. The `host_*` guard must
 * run before either path. The process-role signal and the IPC forward are
 * mocked so the test controls the branch without spawning a subprocess.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEventEnvelope } from "../../api/index.js";

let sideProcess = false;
const forwardCalls: Array<{
  event: AssistantEventEnvelope;
  options: unknown;
}> = [];

mock.module("../../runtime/process-role.js", () => ({
  isMainDaemonProcess: () => !sideProcess,
  markCurrentProcessAsMainDaemon: () => {},
}));

mock.module("../../ipc/events-publish-client.js", () => ({
  EVENTS_PUBLISH_IPC_METHOD: "/events/publish",
  forwardEventPublishToDaemon: async (
    event: AssistantEventEnvelope,
    options: unknown,
  ) => {
    forwardCalls.push({ event, options });
  },
}));

const { assistantEventHub } =
  await import("../../runtime/assistant-event-hub.js");
const { publishEvent } = await import("../publish-event.js");

function syncEvent(): AssistantEventEnvelope {
  return {
    id: "evt-1",
    conversationId: "conv-1",
    emittedAt: "2026-01-01T00:00:00.000Z",
    message: {
      type: "sync_changed",
      tags: ["my-app:items"],
    } as unknown as AssistantEventEnvelope["message"],
  };
}

function collectLocalDeliveries(): {
  received: AssistantEventEnvelope[];
  dispose: () => void;
} {
  const received: AssistantEventEnvelope[] = [];
  const sub = assistantEventHub.subscribe({
    type: "process",
    callback: (event) => {
      received.push(event);
    },
  });
  return { received, dispose: () => sub.dispose() };
}

beforeEach(() => {
  sideProcess = false;
  forwardCalls.length = 0;
});

describe("publishEvent — daemon vs side-process routing", () => {
  test("in the daemon, publishes on the local hub (no IPC forward)", async () => {
    sideProcess = false;
    const local = collectLocalDeliveries();
    try {
      await publishEvent(syncEvent());
    } finally {
      local.dispose();
    }
    expect(local.received).toHaveLength(1);
    expect(local.received[0].message.type).toBe("sync_changed");
    expect(forwardCalls).toHaveLength(0);
  });

  test("in a side process, forwards to the daemon (no local publish)", async () => {
    sideProcess = true;
    const local = collectLocalDeliveries();
    try {
      await publishEvent(syncEvent());
    } finally {
      local.dispose();
    }
    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0].event.message.type).toBe("sync_changed");
    // The local hub reaches no SSE subscriber in a side process, so nothing is
    // delivered locally.
    expect(local.received).toHaveLength(0);
  });

  test("rejects a host-proxy event before forwarding, even in a side process", async () => {
    sideProcess = true;
    const hostEvent: AssistantEventEnvelope = {
      id: "evt-2",
      emittedAt: "2026-01-01T00:00:00.000Z",
      message: {
        type: "host_bash_request",
      } as unknown as AssistantEventEnvelope["message"],
    };
    await expect(publishEvent(hostEvent)).rejects.toThrow(/host-proxy/);
    expect(forwardCalls).toHaveLength(0);
  });
});

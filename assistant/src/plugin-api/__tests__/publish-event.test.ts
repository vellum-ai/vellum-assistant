/**
 * Tests for the plugin-facing {@link publishEvent} helper. It is a thin wrapper
 * over the capability-restricted event-hub facade, so these assert the two
 * behaviours a caller relies on: a plain event reaches hub subscribers, and a
 * host-proxy control event is rejected.
 */

import { describe, expect, test } from "bun:test";

import type { AssistantEventEnvelope } from "../../api/index.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { publishEvent } from "../publish-event.js";

// A test process defaults to "main daemon" (set by the test preload), so the
// hub publishes locally here rather than forwarding.

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

describe("publishEvent", () => {
  test("delivers a plain event to hub subscribers", async () => {
    const received: AssistantEventEnvelope[] = [];
    const sub = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });
    try {
      await publishEvent(syncEvent());
    } finally {
      sub.dispose();
    }
    expect(received).toHaveLength(1);
    expect(received[0].message.type).toBe("sync_changed");
  });

  test("rejects a host-proxy control event", async () => {
    const hostEvent: AssistantEventEnvelope = {
      id: "evt-2",
      emittedAt: "2026-01-01T00:00:00.000Z",
      message: {
        type: "host_bash_request",
      } as unknown as AssistantEventEnvelope["message"],
    };
    await expect(publishEvent(hostEvent)).rejects.toThrow(/host-proxy/);
  });
});

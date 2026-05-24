/**
 * Tests for self-echo suppression in `AssistantEventHub`.
 *
 * Validates:
 *   - hub.publish(event, { excludeClientId }) skips the matching client
 *     subscriber and delivers to every other matching subscriber.
 *   - Suppression is unconditional: it applies whether the broadcast is
 *     untargeted, conversation-scoped, or capability-targeted.
 *   - `broadcastMessage(sync_changed { originClientId })` derives the
 *     exclusion from the message itself — no caller wiring needed.
 *   - `broadcastMessage(sync_changed)` without an originClientId fans out
 *     to every subscriber (the daemon-internal emit path).
 *   - Process-type subscribers are never excluded by a clientId match.
 */
import { describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  AssistantEventHub,
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";

function makeSyncChangedEvent(originClientId?: string): AssistantEvent {
  return {
    id: "evt_test_sync",
    conversationId: undefined,
    emittedAt: "2026-05-03T00:00:00.000Z",
    message: {
      type: "sync_changed",
      tags: ["conversation:abc:messages"],
      ...(originClientId ? { originClientId } : {}),
    },
  };
}

describe("AssistantEventHub — self-echo suppression (excludeClientId)", () => {
  test("skips the named client and delivers to every other client", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];
    const receivedC: AssistantEvent[] = [];

    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedA.push(e);
      },
    });

    hub.subscribe({
      type: "client",
      clientId: "client-b",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedB.push(e);
      },
    });

    hub.subscribe({
      type: "client",
      clientId: "client-c",
      interfaceId: "macos",
      capabilities: [],
      callback: (e) => {
        receivedC.push(e);
      },
    });

    await hub.publish(makeSyncChangedEvent("client-a"), {
      excludeClientId: "client-a",
    });

    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
    expect(receivedC).toHaveLength(1);
  });

  test("delivers to every subscriber when excludeClientId is omitted", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedA.push(e);
      },
    });
    hub.subscribe({
      type: "client",
      clientId: "client-b",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedB.push(e);
      },
    });

    await hub.publish(makeSyncChangedEvent());

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });

  test("excludeClientId does not match process-type subscribers", async () => {
    const hub = new AssistantEventHub();
    const receivedProcess: AssistantEvent[] = [];

    // A process subscriber sits in the same hub as a client whose id
    // matches `excludeClientId`. It must never be suppressed because
    // `excludeClientId` only matches `type: "client"` entries — process
    // entries have no `clientId` field at all.
    hub.subscribe({
      type: "process",
      callback: (e) => {
        receivedProcess.push(e);
      },
    });

    await hub.publish(makeSyncChangedEvent("client-a"), {
      excludeClientId: "client-a",
    });

    expect(receivedProcess).toHaveLength(1);
  });

  test("excludeClientId composes with conversation-scoped subscribers", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "web",
      capabilities: [],
      filter: { conversationId: "sess_x" },
      callback: (e) => {
        receivedA.push(e);
      },
    });
    hub.subscribe({
      type: "client",
      clientId: "client-b",
      interfaceId: "web",
      capabilities: [],
      filter: { conversationId: "sess_x" },
      callback: (e) => {
        receivedB.push(e);
      },
    });

    // Scoped event for sess_x; both clients filter to sess_x; exclude A.
    const event: AssistantEvent = {
      id: "evt_scoped",
      conversationId: "sess_x",
      emittedAt: "2026-05-03T00:00:00.000Z",
      message: {
        type: "sync_changed",
        tags: ["conversation:sess_x:messages"],
        originClientId: "client-a",
      },
    };

    await hub.publish(event, { excludeClientId: "client-a" });

    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
  });
});

describe("broadcastMessage — derives excludeClientId from sync_changed.originClientId", () => {
  test("skips the originating client when originClientId is present", async () => {
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    const subA = assistantEventHub.subscribe({
      type: "client",
      clientId: "broadcast-a",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedA.push(e);
      },
    });
    const subB = assistantEventHub.subscribe({
      type: "client",
      clientId: "broadcast-b",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedB.push(e);
      },
    });

    try {
      broadcastMessage({
        type: "sync_changed",
        tags: ["resource:test"],
        originClientId: "broadcast-a",
      });
      // broadcastMessage queues onto a microtask chain — yield until it
      // drains. Two awaits cover the publish promise + its `.then` chain.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(receivedA).toHaveLength(0);
      expect(receivedB).toHaveLength(1);
    } finally {
      subA.dispose();
      subB.dispose();
    }
  });

  test("fans out to every client when originClientId is absent", async () => {
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    const subA = assistantEventHub.subscribe({
      type: "client",
      clientId: "broadcast-c",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedA.push(e);
      },
    });
    const subB = assistantEventHub.subscribe({
      type: "client",
      clientId: "broadcast-d",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedB.push(e);
      },
    });

    try {
      broadcastMessage({
        type: "sync_changed",
        tags: ["resource:test"],
      });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(receivedA).toHaveLength(1);
      expect(receivedB).toHaveLength(1);
    } finally {
      subA.dispose();
      subB.dispose();
    }
  });

  test("ignores an empty-string originClientId (treats as absent)", async () => {
    const receivedA: AssistantEvent[] = [];

    const subA = assistantEventHub.subscribe({
      type: "client",
      clientId: "broadcast-e",
      interfaceId: "web",
      capabilities: [],
      callback: (e) => {
        receivedA.push(e);
      },
    });

    try {
      broadcastMessage({
        type: "sync_changed",
        tags: ["resource:test"],
        // Exercise the length-zero guard. `originClientId?: string` accepts
        // empty strings at the type level, but production code path can't
        // produce one — `buildSyncChangedMessage` trims and drops empty
        // values before calling `broadcastMessage`.
        originClientId: "",
      });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(receivedA).toHaveLength(1);
    } finally {
      subA.dispose();
    }
  });
});

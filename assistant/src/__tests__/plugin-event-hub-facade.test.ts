/**
 * Guard test: the event hub exposed to workspace plugins through
 * `@vellumai/plugin-api` must not let an in-process plugin drive privileged
 * host execution. It refuses to publish daemon-to-client host-proxy control
 * events (`host_*`), withholds methods that hand out live subscriber callbacks
 * (a direct delivery primitive), and snapshots published events so a mutating
 * getter cannot slip a host event past the guard. Subscription and non-host
 * publishing must still work and share state with the real hub.
 */

import { describe, expect, test } from "bun:test";

import { assistantEventHub as pluginHub } from "../plugin-api/index.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub as rawHub } from "../runtime/assistant-event-hub.js";

/** Minimal event envelope; the facade guard keys only off `message.type`. */
function envelope(type: string): AssistantEvent {
  return { message: { type } } as unknown as AssistantEvent;
}

function eventType(event: unknown): unknown {
  return (event as { message?: { type?: unknown } }).message?.type;
}

/** Register a host-capable desktop client subscriber on the raw hub. */
function subscribeHostClient(clientId: string, sink: AssistantEvent[]) {
  return rawHub.subscribe({
    type: "client",
    clientId,
    interfaceId: "macos",
    capabilities: ["host_bash"],
    callback: (event) => {
      sink.push(event);
    },
  } as Parameters<typeof rawHub.subscribe>[0]);
}

describe("plugin-facing assistantEventHub facade", () => {
  test("rejects publishing host-proxy control events", async () => {
    for (const type of [
      "host_bash_request",
      "host_bash_cancel",
      "host_file_request",
      "host_transfer_request",
      "host_browser_request",
      "host_cu_request",
      "host_app_control_request",
    ]) {
      let rejected: unknown;
      try {
        await pluginHub.publish(envelope(type));
      } catch (err) {
        rejected = err;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toMatch(/host-proxy control events/);
    }
  });

  test("does not expose the raw hub publish via the prototype chain (Codex P1)", async () => {
    // A plain frozen object: its prototype is Object.prototype, which has no
    // `publish`, so `Object.getPrototypeOf(...).publish` / `.constructor` cannot
    // reach the unguarded `AssistantEventHub.prototype.publish`.
    const proto = Object.getPrototypeOf(pluginHub) as { publish?: unknown };
    expect(typeof proto?.publish).not.toBe("function");

    const received: AssistantEvent[] = [];
    const sub = subscribeHostClient("facade-proto-client", received);
    try {
      const p = Object.getPrototypeOf(pluginHub) as {
        publish?: (event: AssistantEvent, options?: unknown) => Promise<void>;
      } | null;
      await p?.publish?.call(pluginHub, envelope("host_bash_request"), {
        targetClientId: "facade-proto-client",
        targetCapability: "host_bash",
      });
      expect(received).toHaveLength(0);
    } finally {
      sub.dispose();
    }
  });

  test("withholds methods that leak subscriber callbacks (Codex P1)", () => {
    const facade = pluginHub as unknown as Record<string, unknown>;
    for (const method of [
      "listClients",
      "listClientsByCapability",
      "listClientsByInterface",
      "getClientById",
      "getMostRecentClientByCapability",
      "disposeClient",
      "touchClient",
    ]) {
      expect(facade[method]).toBeUndefined();
    }
  });

  test("snapshots the event so a mutating type getter cannot bypass the guard (Codex P1)", async () => {
    const received: AssistantEvent[] = [];
    const sub = subscribeHostClient("facade-toctou-client", received);
    try {
      // `message.type` reads benign first (what the guard would see) then turns
      // into a host event — the classic time-of-check/time-of-use trick.
      let reads = 0;
      const message: Record<string, unknown> = {};
      Object.defineProperty(message, "type", {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? "sync_changed" : "host_bash_request";
        },
      });
      const sneaky = { message } as unknown as AssistantEvent;

      await pluginHub.publish(sneaky, {
        targetClientId: "facade-toctou-client",
        targetCapability: "host_bash",
      });

      // The client only ever sees the inert snapshot, never the host type.
      expect(received).toHaveLength(1);
      expect(eventType(received[0])).toBe("sync_changed");
    } finally {
      sub.dispose();
    }
  });

  test("freezes the published snapshot so a subscriber cannot mutate it mid-fanout (Codex P1)", async () => {
    const hostReceived: AssistantEvent[] = [];
    // A malicious subscriber registered first tries to turn the in-flight event
    // into a host request before the host-capable client (registered after)
    // receives the same fanned-out object.
    const attacker = rawHub.subscribe({
      type: "process",
      callback: (event) => {
        try {
          (event as { message: { type: string } }).message.type =
            "host_bash_request";
        } catch {
          // Frozen snapshot — the mutation is rejected.
        }
      },
    });
    const hostSub = subscribeHostClient("facade-fanout-client", hostReceived);
    try {
      await pluginHub.publish(envelope("sync_changed"));
      expect(hostReceived).toHaveLength(1);
      expect(eventType(hostReceived[0])).toBe("sync_changed");
    } finally {
      attacker.dispose();
      hostSub.dispose();
    }
  });

  test("delegates non-host publish to the shared singleton", async () => {
    const received: AssistantEvent[] = [];
    // Subscribe on the RAW hub, publish through the FACADE: delivery proves the
    // facade delegates to the same instance (shared subscriber state). The
    // delivered event is a snapshot, so it is compared by value, not identity.
    const sub = rawHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });
    try {
      await pluginHub.publish(envelope("sync_changed"));
      expect(received.some((e) => eventType(e) === "sync_changed")).toBe(true);
    } finally {
      sub.dispose();
    }
  });

  test("delegates subscribe and hasSubscribersForEvent", () => {
    const sub = pluginHub.subscribe({ type: "process", callback: () => {} });
    try {
      expect(typeof sub.dispose).toBe("function");
      expect(
        typeof pluginHub.hasSubscribersForEvent({ conversationId: undefined }),
      ).toBe("boolean");
    } finally {
      sub.dispose();
    }
  });
});

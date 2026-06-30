/**
 * Guard test: the event hub exposed to workspace plugins through
 * `@vellumai/plugin-api` must refuse to publish daemon-to-client host-proxy
 * control events (`host_*`). Publishing one drives privileged shell / file /
 * input execution on the desktop client, which the host proxies gate upstream;
 * an in-process plugin must not be able to bypass that gate by publishing the
 * event directly. Non-host publishing and subscription must still work and
 * share state with the real hub.
 */

import { describe, expect, test } from "bun:test";

import { assistantEventHub as pluginHub } from "../plugin-api/index.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  type AssistantEventCallback,
  assistantEventHub as rawHub,
} from "../runtime/assistant-event-hub.js";

/** Minimal event envelope; the facade guard keys only off `message.type`. */
function envelope(type: string): AssistantEvent {
  return { message: { type } } as unknown as AssistantEvent;
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

  test("does not expose raw publish through the prototype chain (Codex P1 bypass)", async () => {
    // The facade has no prototype, so `Object.getPrototypeOf` / `.constructor`
    // cannot reach the unguarded `AssistantEventHub.prototype.publish`.
    expect(Object.getPrototypeOf(pluginHub)).toBeNull();
    expect(
      (pluginHub as { constructor?: unknown }).constructor,
    ).toBeUndefined();

    // End-to-end: replicate the reported exploit and assert nothing reaches a
    // host-capable subscriber.
    const received: AssistantEvent[] = [];
    const sub = rawHub.subscribe({
      type: "client",
      clientId: "facade-bypass-test-client",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: (event) => {
        received.push(event);
      },
    } as Parameters<typeof rawHub.subscribe>[0]);
    try {
      const proto = Object.getPrototypeOf(pluginHub) as {
        publish?: (event: AssistantEvent, options?: unknown) => Promise<void>;
      } | null;
      await proto?.publish?.call(pluginHub, envelope("host_bash_request"), {
        targetClientId: "facade-bypass-test-client",
        targetCapability: "host_bash",
      });
      expect(received).toHaveLength(0);
    } finally {
      sub.dispose();
    }
  });

  test("delegates non-host publish to the shared singleton", async () => {
    const received: AssistantEvent[] = [];
    const callback: AssistantEventCallback = (event) => {
      received.push(event);
    };
    // Subscribe on the RAW hub, publish through the FACADE: delivery proves the
    // facade delegates to the same instance (shared subscriber state).
    const sub = rawHub.subscribe({ type: "process", callback });
    try {
      const event = envelope("sync_changed");
      await pluginHub.publish(event);
      expect(received).toContain(event);
    } finally {
      sub.dispose();
    }
  });

  test("delegates subscribe and read queries without throwing", () => {
    const sub = pluginHub.subscribe({ type: "process", callback: () => {} });
    try {
      expect(typeof sub.dispose).toBe("function");
      expect(
        Array.isArray(pluginHub.listClientsByCapability("host_bash")),
      ).toBe(true);
    } finally {
      sub.dispose();
    }
  });
});

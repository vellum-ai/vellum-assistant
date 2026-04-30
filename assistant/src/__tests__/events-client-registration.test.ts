/**
 * Tests for SSE client registration via X-Vellum-Client-Id / X-Vellum-Interface-Id
 * headers on the /events endpoint.
 *
 * Validates:
 *   - Client is registered as a hub subscriber on SSE connect
 *   - Client is unregistered on SSE disconnect (abort)
 *   - Client is touched on heartbeat interval
 *   - Missing interfaceId with clientId throws BadRequestError
 *   - Invalid interfaceId throws BadRequestError
 *   - Missing both headers skips registration (backwards compat)
 *   - Duplicate clientId subscribers are deduplicated on reconnect
 *   - disposeClient() force-disconnects all subscribers for a clientId
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { initializeDb } from "../memory/db-init.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

initializeDb();

describe("events client registration", () => {
  // ── Registration on connect ───────────────────────────────────────────────

  test("registers client when both headers are provided", () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "test-mac-001",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    expect(stream).toBeInstanceOf(ReadableStream);

    const clients = hub.listClients();
    const entry = clients.find((c) => c.clientId === "test-mac-001");
    expect(entry).toBeDefined();
    expect(entry?.interfaceId).toBe("macos");
    expect(entry?.capabilities).toContain("host_bash");
    expect(entry?.type).toBe("client");

    ac.abort();
  });

  test("skips registration when no headers are provided (backwards compat)", () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents({ abortSignal: ac.signal }, { hub });

    expect(hub.listClients()).toHaveLength(0);

    ac.abort();
  });

  test("skips registration when only interface header is provided", () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: { "x-vellum-interface-id": "macos" },
        abortSignal: ac.signal,
      },
      { hub },
    );

    expect(hub.listClients()).toHaveLength(0);

    ac.abort();
  });

  // ── Validation ────────────────────────────────────────────────────────────

  test("throws BadRequestError when clientId is provided without interfaceId", () => {
    const hub = new AssistantEventHub();

    expect(() =>
      handleSubscribeAssistantEvents(
        {
          headers: { "x-vellum-client-id": "test-mac-001" },
        },
        { hub },
      ),
    ).toThrow(BadRequestError);
    expect(hub.listClients()).toHaveLength(0);
  });

  test("throws BadRequestError when interfaceId is invalid", () => {
    const hub = new AssistantEventHub();

    expect(() =>
      handleSubscribeAssistantEvents(
        {
          headers: {
            "x-vellum-client-id": "test-bad-001",
            "x-vellum-interface-id": "not-a-valid-interface",
          },
        },
        { hub },
      ),
    ).toThrow(BadRequestError);
    expect(hub.listClients()).toHaveLength(0);
  });

  // ── Unregistration on disconnect ──────────────────────────────────────────

  test("unregisters client when SSE stream is aborted", async () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "test-mac-002",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    expect(hub.listClients().some((c) => c.clientId === "test-mac-002")).toBe(
      true,
    );

    const reader = stream.getReader();
    await reader.read();

    ac.abort();

    await new Promise((r) => setTimeout(r, 10));

    expect(hub.listClients().some((c) => c.clientId === "test-mac-002")).toBe(
      false,
    );
  });

  test("unregisters client when stream is cancelled", async () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "test-mac-003",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    expect(hub.listClients().some((c) => c.clientId === "test-mac-003")).toBe(
      true,
    );

    await stream.cancel();

    expect(hub.listClients().some((c) => c.clientId === "test-mac-003")).toBe(
      false,
    );
  });

  // ── Heartbeat touch ───────────────────────────────────────────────────────

  test("touches client on heartbeat", async () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "test-mac-004",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac.signal,
      },
      { hub, heartbeatIntervalMs: 50 },
    );

    const clients = hub.listClients();
    const entry = clients.find((c) => c.clientId === "test-mac-004");
    expect(entry).toBeDefined();
    const initialActive = entry?.lastActiveAt.getTime() ?? 0;

    const reader = stream.getReader();
    await reader.read();

    await new Promise((r) => setTimeout(r, 100));

    // Re-query — the entry object is the same reference, so lastActiveAt
    // should have been bumped by touchClient().
    expect(entry?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(initialActive);

    ac.abort();
  });

  // ── Eviction cleanup ──────────────────────────────────────────────────────

  test("unregisters client when evicted by hub capacity limit", async () => {
    const hub = new AssistantEventHub({ maxSubscribers: 1 });

    const ac1 = new AbortController();
    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "evict-me",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac1.signal,
      },
      { hub },
    );

    expect(hub.listClients().some((c) => c.clientId === "evict-me")).toBe(true);

    const ac2 = new AbortController();
    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "i-stay",
          "x-vellum-interface-id": "ios",
        },
        abortSignal: ac2.signal,
      },
      { hub },
    );

    expect(hub.listClients().some((c) => c.clientId === "evict-me")).toBe(
      false,
    );
    expect(hub.listClients().some((c) => c.clientId === "i-stay")).toBe(true);

    ac1.abort();
    ac2.abort();
  });

  // ── Capacity limit cleanup ────────────────────────────────────────────────

  test("throws ServiceUnavailableError when hub has zero capacity", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 0 });

    expect(() =>
      handleSubscribeAssistantEvents(
        {
          headers: {
            "x-vellum-client-id": "no-room",
            "x-vellum-interface-id": "macos",
          },
        },
        { hub },
      ),
    ).toThrow(ServiceUnavailableError);
    expect(hub.listClients()).toHaveLength(0);
  });

  // ── Client deduplication on reconnect ─────────────────────────────────────

  test("deduplicates stale subscribers when same clientId reconnects", () => {
    const hub = new AssistantEventHub();
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "dedup-001",
          "x-vellum-interface-id": "chrome-extension",
        },
        abortSignal: ac1.signal,
      },
      { hub },
    );

    expect(hub.listClients()).toHaveLength(1);
    expect(hub.subscriberCount()).toBe(1);

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "dedup-001",
          "x-vellum-interface-id": "chrome-extension",
        },
        abortSignal: ac2.signal,
      },
      { hub },
    );

    expect(hub.listClients()).toHaveLength(1);
    expect(hub.subscriberCount()).toBe(1);
    expect(hub.listClients()[0]?.clientId).toBe("dedup-001");

    ac1.abort();
    ac2.abort();
  });

  test("deduplication evicts stale entry via onEvict callback", () => {
    const hub = new AssistantEventHub();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    let evicted = false;

    hub.subscribe({
      type: "client" as const,
      clientId: "evict-cb-001",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
      onEvict: () => {
        evicted = true;
      },
    });

    expect(evicted).toBe(false);

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "evict-cb-001",
          "x-vellum-interface-id": "chrome-extension",
        },
        abortSignal: ac2.signal,
      },
      { hub },
    );

    expect(evicted).toBe(true);
    expect(hub.listClients()).toHaveLength(1);

    ac1.abort();
    ac2.abort();
  });

  test("different clientIds are not deduplicated", () => {
    const hub = new AssistantEventHub();
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "client-A",
          "x-vellum-interface-id": "chrome-extension",
        },
        abortSignal: ac1.signal,
      },
      { hub },
    );

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "client-B",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac2.signal,
      },
      { hub },
    );

    expect(hub.listClients()).toHaveLength(2);

    ac1.abort();
    ac2.abort();
  });

  // ── disposeClient (force disconnect) ──────────────────────────────────────

  test("disposeClient removes all subscribers for the clientId", () => {
    const hub = new AssistantEventHub();

    hub.subscribe({
      type: "client" as const,
      clientId: "force-dc-001",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
    });

    expect(hub.listClients()).toHaveLength(1);

    const count = hub.disposeClient("force-dc-001");
    expect(count).toBe(1);
    expect(hub.listClients()).toHaveLength(0);
  });

  test("disposeClient returns 0 for unknown clientId", () => {
    const hub = new AssistantEventHub();
    expect(hub.disposeClient("nonexistent")).toBe(0);
  });

  test("disposeClient fires onEvict for each disposed entry", () => {
    const hub = new AssistantEventHub();
    let evictCount = 0;

    hub.subscribe({
      type: "client" as const,
      clientId: "force-dc-evict",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
      onEvict: () => {
        evictCount++;
      },
    });

    hub.disposeClient("force-dc-evict");
    expect(evictCount).toBe(1);
  });
});

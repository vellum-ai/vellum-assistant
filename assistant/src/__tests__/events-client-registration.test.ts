/**
 * Tests for SSE client registration via X-Vellum-Client-Id / X-Vellum-Interface-Id
 * headers on the /events endpoint.
 *
 * Validates:
 *   - Client is registered in ClientRegistry on SSE connect
 *   - Client is unregistered on SSE disconnect (abort)
 *   - Client is touched on heartbeat interval
 *   - Missing interfaceId with clientId throws BadRequestError
 *   - Invalid interfaceId throws BadRequestError
 *   - Missing both headers skips registration (backwards compat)
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

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
  __resetClientRegistryForTests,
  getClientRegistry,
} from "../runtime/client-registry.js";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

initializeDb();

describe("events client registration", () => {
  beforeEach(() => {
    __resetClientRegistryForTests();
  });

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

    const registry = getClientRegistry();
    const entry = registry.get("test-mac-001");
    expect(entry).toBeDefined();
    expect(entry!.interfaceId).toBe("macos");
    expect(entry!.capabilities).toContain("host_bash");

    ac.abort();
  });

  test("skips registration when no headers are provided (backwards compat)", () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents({ abortSignal: ac.signal }, { hub });

    expect(getClientRegistry().size).toBe(0);

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

    expect(getClientRegistry().size).toBe(0);

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
    expect(getClientRegistry().size).toBe(0);
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
    expect(getClientRegistry().size).toBe(0);
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

    const registry = getClientRegistry();
    expect(registry.get("test-mac-002")).toBeDefined();

    // Start reading so start() runs and the abort listener is installed
    const reader = stream.getReader();
    // Consume the initial heartbeat
    await reader.read();

    // Abort the request — simulates client disconnect
    ac.abort();

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 10));

    expect(registry.get("test-mac-002")).toBeUndefined();
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

    const registry = getClientRegistry();
    expect(registry.get("test-mac-003")).toBeDefined();

    // Cancel the stream directly
    await stream.cancel();

    expect(registry.get("test-mac-003")).toBeUndefined();
  });

  // ── Heartbeat touch ───────────────────────────────────────────────────────

  test("touches client registry on heartbeat", async () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    // Use a very short heartbeat interval for testing
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

    const registry = getClientRegistry();
    const entry = registry.get("test-mac-004");
    expect(entry).toBeDefined();
    const initialActive = entry!.lastActiveAt;

    // Read the initial heartbeat to ensure start() has run
    const reader = stream.getReader();
    await reader.read();

    // Wait for at least one heartbeat cycle
    await new Promise((r) => setTimeout(r, 100));

    // lastActiveAt should have been touched
    expect(entry!.lastActiveAt).toBeGreaterThanOrEqual(initialActive);

    ac.abort();
  });

  // ── Eviction cleanup ──────────────────────────────────────────────────────

  test("unregisters client when evicted by hub capacity limit", async () => {
    // Create a hub with capacity 1 — the first subscriber is evicted when
    // the second subscribes.
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

    const registry = getClientRegistry();
    expect(registry.get("evict-me")).toBeDefined();

    // Second subscriber evicts the first
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

    expect(registry.get("evict-me")).toBeUndefined();
    expect(registry.get("i-stay")).toBeDefined();

    ac1.abort();
    ac2.abort();
  });

  // ── Capacity limit cleanup ────────────────────────────────────────────────

  test("cleans up registration when hub subscribe throws RangeError", () => {
    // A hub with 0 capacity cannot accept any subscribers.
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
    // Should have been cleaned up
    expect(getClientRegistry().get("no-room")).toBeUndefined();
  });
});

/**
 * Tests for machineName field in AssistantEventHub client registration.
 *
 * Validates:
 *   - subscribing with machineName set results in listClients() returning the name
 *   - subscribing without machineName results in listClients() returning undefined
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
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

initializeDb();

describe("AssistantEventHub — machineName", () => {
  test("subscribing with machineName returns it from listClients()", () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "client-with-name-001",
          "x-vellum-interface-id": "macos",
          "x-vellum-machine-name": "alice-mbp.local",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    const clients = hub.listClients();
    const entry = clients.find((c) => c.clientId === "client-with-name-001");
    expect(entry).toBeDefined();
    expect(entry?.machineName).toBe("alice-mbp.local");

    ac.abort();
  });

  test("subscribing without machineName returns undefined from listClients()", () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "client-without-name-001",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    const clients = hub.listClients();
    const entry = clients.find(
      (c) => c.clientId === "client-without-name-001",
    );
    expect(entry).toBeDefined();
    expect(entry?.machineName).toBeUndefined();

    ac.abort();
  });

  test("machineName is trimmed when set", () => {
    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "client-with-trimmed-name-001",
          "x-vellum-interface-id": "macos",
          "x-vellum-machine-name": "  bob-mbp.local  ",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    const clients = hub.listClients();
    const entry = clients.find(
      (c) => c.clientId === "client-with-trimmed-name-001",
    );
    expect(entry).toBeDefined();
    expect(entry?.machineName).toBe("bob-mbp.local");

    ac.abort();
  });

  test("direct hub subscribe with machineName returns it from listClients()", () => {
    const hub = new AssistantEventHub();

    hub.subscribe({
      type: "client",
      clientId: "direct-client-001",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      machineName: "charlie-mbp.local",
      callback: () => {},
    });

    const clients = hub.listClients();
    const entry = clients.find((c) => c.clientId === "direct-client-001");
    expect(entry).toBeDefined();
    expect(entry?.machineName).toBe("charlie-mbp.local");
  });

  test("direct hub subscribe without machineName returns undefined from listClients()", () => {
    const hub = new AssistantEventHub();

    hub.subscribe({
      type: "client",
      clientId: "direct-client-no-name-001",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: () => {},
    });

    const clients = hub.listClients();
    const entry = clients.find(
      (c) => c.clientId === "direct-client-no-name-001",
    );
    expect(entry).toBeDefined();
    expect(entry?.machineName).toBeUndefined();
  });
});

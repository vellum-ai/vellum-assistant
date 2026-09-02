/**
 * Tests for the client registry routes.
 *
 * GET /v1/clients (list_clients) applies a same-user filter to listings:
 * - Caller sees only clients owned by their `actorPrincipalId`.
 * - Clients with no stored `actorPrincipalId` are filtered out (fail-closed).
 * - Dev-bypass mode (`isHttpAuthDisabled()`) returns all clients.
 *
 * POST /v1/clients/presence (report_client_presence) records presence keyed
 * off the `x-vellum-client-id` header, and applies the same ownership posture:
 * only the actor that owns the target client may report its presence. The
 * handler resolves the client before comparing owners, so an unconnected
 * clientId (a report racing an SSE reconnect) and a connected-but-unowned one
 * are distinct paths that both answer `{ recorded: false }`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must be set up before importing the route) ──────────────

let fakeHttpAuthDisabled = false;

mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

// ── Real imports (after mocks) ────────────────────────────────────────────

import {
  clearHubClients,
  registerHubClient,
} from "../../../__tests__/helpers/hub-clients.js";
import { assistantEventHub } from "../../assistant-event-hub.js";
import { ROUTES } from "../client-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

afterAll(() => {
  mock.restore();
});

// ── Test helpers ──────────────────────────────────────────────────────────

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

type ListClientsResponse = {
  clients: Array<{
    clientId: string;
    interfaceId: string;
    capabilities: string[];
    machineName?: string;
    connectedAt: string;
    lastActiveAt: string;
    degraded?: boolean;
  }>;
};

function registerClient(args: {
  clientId: string;
  actorPrincipalId?: string;
}): void {
  registerHubClient({
    hub: assistantEventHub,
    clientId: args.clientId,
    capabilities: ["host_bash", "host_file", "host_cu"],
    actorPrincipalId: args.actorPrincipalId,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("list_clients route — same-user filter", () => {
  beforeEach(() => {
    fakeHttpAuthDisabled = false;
    clearHubClients(assistantEventHub);
  });

  test("returns only clients owned by the calling actor", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });
    registerClient({ clientId: "client-A2", actorPrincipalId: "user-A" });
    registerClient({ clientId: "client-B1", actorPrincipalId: "user-B" });

    const handler = findHandler("list_clients");
    const result = handler({
      headers: { "x-vellum-actor-principal-id": "user-A" },
    }) as ListClientsResponse;

    const ids = result.clients.map((c) => c.clientId).sort();
    expect(ids).toEqual(["client-A1", "client-A2"]);
  });

  test("filters out cross-user clients when listing as a different user", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });
    registerClient({ clientId: "client-B1", actorPrincipalId: "user-B" });

    const handler = findHandler("list_clients");
    const result = handler({
      headers: { "x-vellum-actor-principal-id": "user-B" },
    }) as ListClientsResponse;

    const ids = result.clients.map((c) => c.clientId);
    expect(ids).toEqual(["client-B1"]);
  });

  test("filters out clients with no stored actorPrincipalId (fail-closed)", () => {
    registerClient({
      clientId: "client-noprincipal",
      actorPrincipalId: undefined,
    });
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("list_clients");
    const result = handler({
      headers: { "x-vellum-actor-principal-id": "user-A" },
    }) as ListClientsResponse;

    const ids = result.clients.map((c) => c.clientId);
    expect(ids).toEqual(["client-A1"]);
  });

  test("filters out all clients when caller has no actorPrincipalId header (fail-closed)", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("list_clients");
    const result = handler({}) as ListClientsResponse;

    expect(result.clients).toEqual([]);
  });

  test("dev-bypass mode returns all clients regardless of actor", () => {
    fakeHttpAuthDisabled = true;
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });
    registerClient({ clientId: "client-B1", actorPrincipalId: "user-B" });
    registerClient({
      clientId: "client-noprincipal",
      actorPrincipalId: undefined,
    });

    const handler = findHandler("list_clients");
    const result = handler({
      headers: { "x-vellum-actor-principal-id": "user-A" },
    }) as ListClientsResponse;

    const ids = result.clients.map((c) => c.clientId).sort();
    expect(ids).toEqual(["client-A1", "client-B1", "client-noprincipal"]);
  });

  test("includes a degraded flag (false for a freshly connected client)", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("list_clients");
    const result = handler({
      headers: { "x-vellum-actor-principal-id": "user-A" },
    }) as ListClientsResponse;

    expect(result.clients).toHaveLength(1);
    expect(result.clients[0].degraded).toBe(false);
  });
});

describe("report_client_presence route", () => {
  beforeEach(() => {
    fakeHttpAuthDisabled = false;
    clearHubClients(assistantEventHub);
  });

  test("records presence against the client named by the header", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_client_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { state: "active" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: true });
    expect(assistantEventHub.getClientById("client-A1")?.presence?.state).toBe(
      "active",
    );
  });

  test("returns recorded false when the reported client is not connected", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_client_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-gone",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { state: "idle" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
    expect(
      assistantEventHub.getClientById("client-A1")?.presence,
    ).toBeUndefined();
  });

  test("returns recorded false when the caller does not own the client", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_client_presence");
    handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { state: "active" },
    });

    const result = handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-B",
      },
      body: { state: "away" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
    expect(assistantEventHub.getClientById("client-A1")?.presence?.state).toBe(
      "active",
    );
  });

  test("returns recorded false when the caller sends no principal header", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_client_presence");
    const result = handler({
      headers: { "x-vellum-client-id": "client-A1" },
      body: { state: "active" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
    expect(
      assistantEventHub.getClientById("client-A1")?.presence,
    ).toBeUndefined();
  });

  test("returns recorded false for a client with no stored actorPrincipalId", () => {
    registerClient({
      clientId: "client-noprincipal",
      actorPrincipalId: undefined,
    });

    const handler = findHandler("report_client_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-noprincipal",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { state: "active" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
    expect(
      assistantEventHub.getClientById("client-noprincipal")?.presence,
    ).toBeUndefined();
  });

  test("dev-bypass mode records presence without an ownership check", () => {
    fakeHttpAuthDisabled = true;
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_client_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-B",
      },
      body: { state: "idle" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: true });
    expect(assistantEventHub.getClientById("client-A1")?.presence?.state).toBe(
      "idle",
    );
  });

  test("dev-bypass mode returns recorded false for an unconnected client", () => {
    fakeHttpAuthDisabled = true;

    const handler = findHandler("report_client_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-gone",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { state: "idle" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
  });

  test("throws BadRequestError when the client-id header is missing", () => {
    const handler = findHandler("report_client_presence");

    expect(() => handler({ body: { state: "active" } })).toThrow(
      BadRequestError,
    );
    expect(() =>
      handler({ headers: { "x-vellum-client-id": "  " }, body: {} }),
    ).toThrow(BadRequestError);
  });

  test("rejects an unknown presence state", () => {
    registerClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_client_presence");

    expect(() =>
      handler({
        headers: {
          "x-vellum-client-id": "client-A1",
          "x-vellum-actor-principal-id": "user-A",
        },
        body: { state: "asleep" },
      }),
    ).toThrow(BadRequestError);
    expect(
      assistantEventHub.getClientById("client-A1")?.presence,
    ).toBeUndefined();
  });
});

describe("report_web_presence route", () => {
  beforeEach(() => {
    fakeHttpAuthDisabled = false;
    clearHubClients(assistantEventHub);
  });

  function registerWebClient(args: {
    clientId: string;
    actorPrincipalId?: string;
  }): void {
    registerHubClient({
      hub: assistantEventHub,
      clientId: args.clientId,
      interfaceId: "web",
      actorPrincipalId: args.actorPrincipalId,
    });
  }

  test("records visibility and focused conversation against the client named by the header", () => {
    registerWebClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_web_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { visible: true, focusedConversationId: "conv-1" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: true });
    expect(
      assistantEventHub.getClientById("client-A1")?.webPresence,
    ).toMatchObject({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("accepts a null focusedConversationId", () => {
    registerWebClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_web_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { visible: false, focusedConversationId: null },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: true });
    expect(
      assistantEventHub.getClientById("client-A1")?.webPresence,
    ).toMatchObject({
      visible: false,
      focusedConversationId: null,
    });
  });

  test("returns recorded false when the reported client is not connected", () => {
    const handler = findHandler("report_web_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-gone",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { visible: true, focusedConversationId: "conv-1" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
  });

  test("returns recorded false when the caller does not own the client", () => {
    registerWebClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_web_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-B",
      },
      body: { visible: true, focusedConversationId: "conv-1" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
    expect(
      assistantEventHub.getClientById("client-A1")?.webPresence,
    ).toBeUndefined();
  });

  test("returns recorded false for a client with no stored actorPrincipalId", () => {
    registerWebClient({ clientId: "client-noprincipal" });

    const handler = findHandler("report_web_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-noprincipal",
        "x-vellum-actor-principal-id": "user-A",
      },
      body: { visible: true, focusedConversationId: "conv-1" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: false });
    expect(
      assistantEventHub.getClientById("client-noprincipal")?.webPresence,
    ).toBeUndefined();
  });

  test("dev-bypass mode records presence without an ownership check", () => {
    fakeHttpAuthDisabled = true;
    registerWebClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_web_presence");
    const result = handler({
      headers: {
        "x-vellum-client-id": "client-A1",
        "x-vellum-actor-principal-id": "user-B",
      },
      body: { visible: true, focusedConversationId: "conv-1" },
    }) as { recorded: boolean };

    expect(result).toEqual({ recorded: true });
  });

  test("throws BadRequestError when the client-id header is missing", () => {
    const handler = findHandler("report_web_presence");

    expect(() =>
      handler({ body: { visible: true, focusedConversationId: "conv-1" } }),
    ).toThrow(BadRequestError);
  });

  test("throws BadRequestError for a malformed body", () => {
    registerWebClient({ clientId: "client-A1", actorPrincipalId: "user-A" });

    const handler = findHandler("report_web_presence");

    expect(() =>
      handler({
        headers: {
          "x-vellum-client-id": "client-A1",
          "x-vellum-actor-principal-id": "user-A",
        },
        body: { visible: "yes", focusedConversationId: "conv-1" },
      }),
    ).toThrow(BadRequestError);
  });
});

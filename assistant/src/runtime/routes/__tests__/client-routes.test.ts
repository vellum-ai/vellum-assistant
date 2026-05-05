/**
 * Tests for the GET /v1/clients (list_clients) route.
 *
 * Validates the same-user filter applied to client listings:
 * - Caller sees only clients owned by their `actorPrincipalId`.
 * - Clients with no stored `actorPrincipalId` are filtered out (fail-closed).
 * - Dev-bypass mode (`isHttpAuthDisabled()`) returns all clients.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must be set up before importing the route) ──────────────

let fakeHttpAuthDisabled = false;

mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Real imports (after mocks) ────────────────────────────────────────────

import { assistantEventHub } from "../../assistant-event-hub.js";
import { ROUTES } from "../client-routes.js";
import type { RouteDefinition } from "../types.js";

afterAll(() => {
  mock.restore();
});

// ── Test helpers ──────────────────────────────────────────────────────────

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
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
  }>;
};

function registerClient(args: {
  clientId: string;
  actorPrincipalId?: string;
}): void {
  assistantEventHub.subscribe({
    type: "client",
    clientId: args.clientId,
    interfaceId: "macos",
    capabilities: ["host_bash", "host_file", "host_cu"],
    actorPrincipalId: args.actorPrincipalId,
    callback: () => {},
  });
}

function clearHub(): void {
  const ids = assistantEventHub.listClients().map((c) => c.clientId);
  for (const id of ids) {
    assistantEventHub.disposeClient(id);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("list_clients route — same-user filter", () => {
  beforeEach(() => {
    fakeHttpAuthDisabled = false;
    clearHub();
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
});

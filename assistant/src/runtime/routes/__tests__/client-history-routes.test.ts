import { afterAll, describe, expect, mock, test } from "bun:test";

const historyResult = {
  events: [
    {
      id: "evt-1",
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-1",
      reason: "sse_open" as const,
      occurredAt: Date.parse("2026-09-16T12:00:00.000Z"),
      actorPrincipalId: "user-123",
      clientVersion: "0.12.1",
      sseWatchdog: true,
      machineName: null,
    },
  ],
  sessions: [
    {
      clientId: "client-123",
      interfaceId: "chrome-extension",
      startedAt: Date.parse("2026-09-16T12:00:00.000Z"),
      endedAt: null,
      durationMs: 60_000,
      flapCount: 1,
      openReason: "sse_open" as const,
      closeReason: null,
      clientVersion: "0.12.1",
      sseWatchdog: true,
      machineName: null,
      connectionIds: ["conn-1", "conn-2"],
    },
  ],
};

const listHistory = mock((params: Record<string, unknown>) => {
  if (params.actorPrincipalId === "user-123") {
    return historyResult;
  }
  return { events: [], sessions: [] };
});

mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => false,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../../../persistence/client-connection-events-store.js", () => ({
  listClientConnectionHistory: listHistory,
}));

import { ROUTES } from "../client-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

afterAll(() => {
  mock.restore();
});

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

describe("list_client_history", () => {
  test("returns ISO timestamps for the calling actor", () => {
    const handler = findHandler("list_client_history");
    const result = handler({
      headers: { "x-vellum-actor-principal-id": "user-123" },
      queryParams: { clientId: "client-123" },
    }) as {
      sessions: Array<{ startedAt: string; endedAt: string | null }>;
      events: Array<{ occurredAt: string }>;
    };

    expect(listHistory).toHaveBeenCalled();
    expect(result.sessions[0].startedAt).toBe("2026-09-16T12:00:00.000Z");
    expect(result.sessions[0].endedAt).toBeNull();
    expect(result.events[0].occurredAt).toBe("2026-09-16T12:00:00.000Z");
  });

  test("hides other actors' history", () => {
    const handler = findHandler("list_client_history");
    const result = handler({
      headers: { "x-vellum-actor-principal-id": "user-other" },
    }) as { sessions: unknown[]; events: unknown[] };

    expect(result.sessions).toEqual([]);
    expect(result.events).toEqual([]);
  });

  test("rejects an invalid since value", () => {
    const handler = findHandler("list_client_history");
    expect(() =>
      handler({
        headers: { "x-vellum-actor-principal-id": "user-123" },
        queryParams: { since: "not-a-date" },
      }),
    ).toThrow(BadRequestError);
  });
});

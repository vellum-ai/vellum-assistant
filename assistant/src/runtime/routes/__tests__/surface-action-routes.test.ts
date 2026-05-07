/**
 * Tests for surface-action route handlers.
 *
 * Focus is the rehydrate-on-miss path: after daemon restart or LRU eviction,
 * the in-memory conversation map is empty even though the surface still
 * persists as a `ui_surface` content block in the messages table. The handler
 * must fall back to a DB scan, then call `getOrCreateConversation` so the
 * action dispatches against a live conversation with restored `surfaceState`.
 *
 * Strategy: mock `conversation-store` and `raw-query` at module boundaries,
 * import ROUTES afterwards, find each handler by operationId, and exercise.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface StubConversation {
  id: string;
  handleSurfaceActionResult?:
    | { accepted: true; conversationId?: string }
    | { accepted: false; error: string };
  handleSurfaceActionThrows?: Error;
  handleSurfaceUndoCalled?: boolean;
  handleSurfaceUndoThrows?: Error;
  surfaceActionCalls: Array<{
    surfaceId: string;
    actionId: string;
    data: unknown;
  }>;
}

let memoryById: StubConversation | null = null;
let memoryBySurface: StubConversation | null = null;
let rehydrated: StubConversation | null = null;
let rawGetReturn: { conversation_id: string } | null = null;

const findConvCalls: string[] = [];
const findBySurfaceCalls: string[] = [];
const getOrCreateCalls: string[] = [];
const rawGetCalls: Array<{ sql: string; params: unknown[] }> = [];

mock.module("../../../daemon/conversation-store.js", () => ({
  findConversation: (id: string) => {
    findConvCalls.push(id);
    return memoryById ?? undefined;
  },
  findConversationBySurfaceId: (surfaceId: string) => {
    findBySurfaceCalls.push(surfaceId);
    return memoryBySurface ?? undefined;
  },
  getOrCreateConversation: async (id: string) => {
    getOrCreateCalls.push(id);
    if (!rehydrated) {
      throw new Error(
        `getOrCreateConversation(${id}) called but no rehydrated stub configured`,
      );
    }
    return rehydrated;
  },
}));

mock.module("../../../memory/raw-query.js", () => ({
  rawGet: (sql: string, ...params: unknown[]) => {
    rawGetCalls.push({ sql, params });
    return rawGetReturn;
  },
}));

// Defer route import until after mocks are installed.
const { ROUTES } = await import("../surface-action-routes.js");
const { NotFoundError } = await import("../errors.js");
import type { RouteDefinition } from "../types.js";

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function makeStub(id: string): StubConversation {
  const stub: StubConversation = {
    id,
    handleSurfaceActionResult: { accepted: true },
    surfaceActionCalls: [],
  };
  // Methods reference `stub` so handler invocations land on the same object.
  Object.assign(stub, {
    handleSurfaceAction: async (
      surfaceId: string,
      actionId: string,
      data: unknown,
    ) => {
      stub.surfaceActionCalls.push({ surfaceId, actionId, data });
      if (stub.handleSurfaceActionThrows) throw stub.handleSurfaceActionThrows;
      return stub.handleSurfaceActionResult;
    },
    handleSurfaceUndo: (_surfaceId: string) => {
      stub.handleSurfaceUndoCalled = true;
      if (stub.handleSurfaceUndoThrows) throw stub.handleSurfaceUndoThrows;
    },
  });
  return stub;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  memoryById = null;
  memoryBySurface = null;
  rehydrated = null;
  rawGetReturn = null;
  findConvCalls.length = 0;
  findBySurfaceCalls.length = 0;
  getOrCreateCalls.length = 0;
  rawGetCalls.length = 0;
});

// ---------------------------------------------------------------------------
// triggerSurfaceAction
// ---------------------------------------------------------------------------

describe("triggerSurfaceAction handler", () => {
  test("dispatches against live in-memory conversation when found by surfaceId", async () => {
    const live = makeStub("conv-live");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    const result = await handler({
      body: { surfaceId: "surf-1", actionId: "act-1" },
    });

    expect(result).toEqual({ ok: true });
    expect(findBySurfaceCalls).toEqual(["surf-1"]);
    expect(findConvCalls).toEqual([]);
    expect(rawGetCalls).toEqual([]);
    expect(getOrCreateCalls).toEqual([]);
    expect(live.surfaceActionCalls).toEqual([
      { surfaceId: "surf-1", actionId: "act-1", data: undefined },
    ]);
  });

  test("uses caller-supplied conversationId for in-memory hit", async () => {
    const live = makeStub("conv-explicit");
    memoryById = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: {
        conversationId: "conv-explicit",
        surfaceId: "surf-2",
        actionId: "act-2",
        data: { foo: "bar" },
      },
    });

    expect(findConvCalls).toEqual(["conv-explicit"]);
    expect(findBySurfaceCalls).toEqual([]);
    expect(rawGetCalls).toEqual([]);
    expect(getOrCreateCalls).toEqual([]);
    expect(live.surfaceActionCalls).toEqual([
      { surfaceId: "surf-2", actionId: "act-2", data: { foo: "bar" } },
    ]);
  });

  test("rehydrates via DB fallback when in-memory lookup misses", async () => {
    rawGetReturn = { conversation_id: "conv-from-db" };
    rehydrated = makeStub("conv-from-db");

    const handler = findHandler("triggerSurfaceAction");
    const result = await handler({
      body: { surfaceId: "surf-evicted", actionId: "act-3" },
    });

    expect(result).toEqual({ ok: true });
    expect(findBySurfaceCalls).toEqual(["surf-evicted"]);
    expect(findConvCalls).toEqual([]);
    expect(rawGetCalls).toHaveLength(1);
    // SQL must filter the messages table by ui_surface payload pattern.
    expect(rawGetCalls[0]!.sql).toContain("FROM messages");
    expect(rawGetCalls[0]!.sql).toContain("LIKE");
    expect(rawGetCalls[0]!.params).toEqual([
      `%"surfaceId":"surf-evicted"%`,
    ]);
    expect(getOrCreateCalls).toEqual(["conv-from-db"]);
    expect(rehydrated.surfaceActionCalls).toEqual([
      { surfaceId: "surf-evicted", actionId: "act-3", data: undefined },
    ]);
  });

  test("rehydrates with caller-supplied conversationId after validating DB row", async () => {
    rawGetReturn = { conversation_id: "conv-caller" };
    rehydrated = makeStub("conv-caller");

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: {
        conversationId: "conv-caller",
        surfaceId: "surf-caller",
        actionId: "act-4",
      },
    });

    expect(findConvCalls).toEqual(["conv-caller"]);
    expect(findBySurfaceCalls).toEqual([]);
    // DB scan validates the surface actually exists before rehydrating.
    expect(rawGetCalls).toHaveLength(1);
    expect(getOrCreateCalls).toEqual(["conv-caller"]);
    expect(rehydrated.surfaceActionCalls).toEqual([
      { surfaceId: "surf-caller", actionId: "act-4", data: undefined },
    ]);
  });

  test("returns 404 when surface is not in memory and not in DB", async () => {
    const handler = findHandler("triggerSurfaceAction");

    let caught: unknown;
    try {
      await handler({
        body: { surfaceId: "surf-ghost", actionId: "act-5" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(rawGetCalls).toHaveLength(1);
    // No phantom conversation created.
    expect(getOrCreateCalls).toEqual([]);
  });

  test("returns 404 when caller-supplied conversationId has no matching surface in DB", async () => {
    // rawGetReturn stays null → DB has no row for this surface, so we
    // refuse to rehydrate even though the caller named a conversation.
    const handler = findHandler("triggerSurfaceAction");

    let caught: unknown;
    try {
      await handler({
        body: {
          conversationId: "conv-deleted",
          surfaceId: "surf-x",
          actionId: "act-x",
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    // Crucially, we did NOT call getOrCreateConversation — the previous
    // version would have created a phantom empty conversation here.
    expect(getOrCreateCalls).toEqual([]);
  });

  test("returns 404 when caller-supplied conversationId mismatches the DB row", async () => {
    // Surface exists in conv-real, but caller asserts conv-other.
    rawGetReturn = { conversation_id: "conv-real" };
    const handler = findHandler("triggerSurfaceAction");

    let caught: unknown;
    try {
      await handler({
        body: {
          conversationId: "conv-other",
          surfaceId: "surf-shared",
          actionId: "act-x",
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(getOrCreateCalls).toEqual([]);
  });

  test("escapes LIKE wildcards in surfaceId", async () => {
    // A request with `surfaceId: "%"` must not match unrelated rows. We
    // assert the SQL uses ESCAPE and the bound parameter has the wildcard
    // backslash-escaped.
    const handler = findHandler("triggerSurfaceAction");

    try {
      await handler({
        body: { surfaceId: "%", actionId: "act-evil" },
      });
    } catch {
      /* expected NotFoundError, we only care about the SQL */
    }

    expect(rawGetCalls).toHaveLength(1);
    expect(rawGetCalls[0]!.sql).toContain("ESCAPE");
    expect(rawGetCalls[0]!.params).toEqual([`%"surfaceId":"\\%"%`]);
  });

  test("propagates accepted=false rejection as BadRequestError", async () => {
    const live = makeStub("conv-reject");
    live.handleSurfaceActionResult = {
      accepted: false,
      error: "surface already completed",
    };
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");

    let caught: unknown;
    try {
      await handler({
        body: { surfaceId: "surf-done", actionId: "act-y" },
      });
    } catch (err) {
      caught = err;
    }

    // BadRequestError is a RouteError — verify the error message bubbled.
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("surface already completed");
  });
});

// ---------------------------------------------------------------------------
// undoSurfaceAction
// ---------------------------------------------------------------------------

describe("undoSurfaceAction handler", () => {
  test("dispatches against live in-memory conversation", async () => {
    const live = makeStub("conv-undo-live");
    memoryById = live;

    const handler = findHandler("undoSurfaceAction");
    const result = await handler({
      body: { conversationId: "conv-undo-live" },
      pathParams: { id: "surf-undo-1" },
    });

    expect(result).toEqual({ ok: true });
    expect(findConvCalls).toEqual(["conv-undo-live"]);
    expect(rawGetCalls).toEqual([]);
    expect(getOrCreateCalls).toEqual([]);
    expect(live.handleSurfaceUndoCalled).toBe(true);
  });

  test("rehydrates via DB fallback when conversation evicted", async () => {
    rawGetReturn = { conversation_id: "conv-undo-from-db" };
    rehydrated = makeStub("conv-undo-from-db");

    const handler = findHandler("undoSurfaceAction");
    const result = await handler({
      body: {},
      pathParams: { id: "surf-undo-evicted" },
    });

    expect(result).toEqual({ ok: true });
    expect(findBySurfaceCalls).toEqual(["surf-undo-evicted"]);
    expect(rawGetCalls).toHaveLength(1);
    expect(rawGetCalls[0]!.params).toEqual([
      `%"surfaceId":"surf-undo-evicted"%`,
    ]);
    expect(getOrCreateCalls).toEqual(["conv-undo-from-db"]);
    expect(rehydrated.handleSurfaceUndoCalled).toBe(true);
  });

  test("returns 404 when surface cannot be located", async () => {
    const handler = findHandler("undoSurfaceAction");

    let caught: unknown;
    try {
      await handler({
        body: {},
        pathParams: { id: "surf-undo-ghost" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(getOrCreateCalls).toEqual([]);
  });
});

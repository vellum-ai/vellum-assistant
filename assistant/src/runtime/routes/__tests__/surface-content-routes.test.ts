/**
 * Tests for the surface-content route handler.
 *
 * Focus is the rehydrate-on-miss path: after daemon restart or LRU
 * eviction, the in-memory conversation map is empty even though the
 * surface still persists as a `ui_surface` content block in the
 * messages table. The handler must fall back to a DB scan via the
 * shared `resolveSurfaceConversation` helper, which calls
 * `getOrCreateConversation` to rehydrate the conversation. The
 * rehydration runs `restoreSurfaceStateFromHistory()` in production,
 * which is what repopulates the surfaceState the handler then reads
 * from — in tests we simulate the rehydrated conversation by stubbing
 * `getOrCreateConversation`'s return value with pre-populated
 * `surfaceState`.
 *
 * Strategy mirrors `surface-action-routes.test.ts`: mock the
 * `conversation-store` and `raw-query` modules at their boundary so
 * the resolver code path executes against the test doubles, import
 * ROUTES afterwards, and dispatch by operationId.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface StoredSurface {
  surfaceType: string;
  title: string | null;
  data: Record<string, unknown>;
}

interface StubConversation {
  id: string;
  surfaceState: Map<string, StoredSurface>;
  currentTurnSurfaces?: Array<{
    surfaceId: string;
    surfaceType: string;
    title?: string | null;
    data: Record<string, unknown>;
  }>;
}

let memoryById: StubConversation | null = null;
let rehydrated: StubConversation | null = null;
let rawGetReturn: { conversation_id: string } | null = null;

const findConvCalls: string[] = [];
const findBySurfaceCalls: string[] = [];
const getOrCreateCalls: string[] = [];
const rawGetCalls: Array<{ sql: string; params: unknown[] }> = [];

mock.module("../../../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => {
    findConvCalls.push(id);
    return memoryById ?? undefined;
  },
  findConversationBySurfaceId: (surfaceId: string) => {
    findBySurfaceCalls.push(surfaceId);
    return undefined;
  },
}));

mock.module("../../../daemon/conversation-store.js", () => ({
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
const { ROUTES } = await import("../surface-content-routes.js");
const { BadRequestError, NotFoundError } = await import("../errors.js");
import type { RouteDefinition } from "../types.js";

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function makeStub(id: string): StubConversation {
  return { id, surfaceState: new Map() };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  memoryById = null;
  rehydrated = null;
  rawGetReturn = null;
  findConvCalls.length = 0;
  findBySurfaceCalls.length = 0;
  getOrCreateCalls.length = 0;
  rawGetCalls.length = 0;
});

// ---------------------------------------------------------------------------
// surfaces_get_content
// ---------------------------------------------------------------------------

describe("surfaces_get_content handler", () => {
  test("serves surface from in-memory surfaceState", async () => {
    const conv = makeStub("conv-active");
    conv.surfaceState.set("surf-1", {
      surfaceType: "card",
      title: "T",
      data: { foo: "bar" },
    });
    memoryById = conv;

    const handler = findHandler("surfaces_get_content");
    const result = await handler({
      pathParams: { surfaceId: "surf-1" },
      queryParams: { conversationId: "conv-active" },
    });

    expect(result).toEqual({
      surfaceId: "surf-1",
      surfaceType: "card",
      title: "T",
      data: { foo: "bar" },
    });
    expect(findConvCalls).toEqual(["conv-active"]);
    // Fast path — never touched the DB or rehydration helpers.
    expect(rawGetCalls).toEqual([]);
    expect(getOrCreateCalls).toEqual([]);
  });

  test("falls back to currentTurnSurfaces when surfaceState misses", async () => {
    const conv = makeStub("conv-mid-turn");
    conv.currentTurnSurfaces = [
      {
        surfaceId: "surf-pending",
        surfaceType: "list",
        title: "Picks",
        data: { items: [] },
      },
    ];
    memoryById = conv;

    const handler = findHandler("surfaces_get_content");
    const result = await handler({
      pathParams: { surfaceId: "surf-pending" },
      queryParams: { conversationId: "conv-mid-turn" },
    });

    expect(result).toEqual({
      surfaceId: "surf-pending",
      surfaceType: "list",
      title: "Picks",
      data: { items: [] },
    });
  });

  // -------------------------------------------------------------------------
  // The bug fix: rehydration on in-memory miss.
  // -------------------------------------------------------------------------
  test("rehydrates from DB when the conversation is not in memory", async () => {
    // Simulate post-restart or post-eviction: nothing in memory, but the
    // surface exists in the messages table and rehydration restores the
    // conversation with its surfaceState repopulated from history.
    memoryById = null;
    rawGetReturn = { conversation_id: "conv-evicted" };
    const restored = makeStub("conv-evicted");
    restored.surfaceState.set("surf-restored", {
      surfaceType: "card",
      title: "Restored",
      data: { from: "history" },
    });
    rehydrated = restored;

    const handler = findHandler("surfaces_get_content");
    const result = await handler({
      pathParams: { surfaceId: "surf-restored" },
      queryParams: { conversationId: "conv-evicted" },
    });

    expect(result).toEqual({
      surfaceId: "surf-restored",
      surfaceType: "card",
      title: "Restored",
      data: { from: "history" },
    });
    // Hit the in-memory map first, missed, fell through to the DB scan,
    // then rehydrated. The DB scan keyed on the surfaceId.
    expect(findConvCalls).toEqual(["conv-evicted"]);
    expect(rawGetCalls).toHaveLength(1);
    expect(rawGetCalls[0]!.params[0]).toBe(`%"surfaceId":"surf-restored"%`);
    expect(getOrCreateCalls).toEqual(["conv-evicted"]);
  });

  test("400s when conversationId is missing", async () => {
    const handler = findHandler("surfaces_get_content");

    let caught: unknown;
    try {
      await handler({
        pathParams: { surfaceId: "surf-1" },
        queryParams: {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestError);
    expect(findConvCalls).toEqual([]);
  });

  test("404s when no row in the DB matches the surfaceId (truly unknown surface)", async () => {
    // Cold-cache miss with no DB row — the surfaceId is bogus or has
    // never been persisted. We must 404, not rehydrate a phantom
    // conversation for the caller-supplied conversationId.
    memoryById = null;
    rawGetReturn = null;

    const handler = findHandler("surfaces_get_content");

    let caught: unknown;
    try {
      await handler({
        pathParams: { surfaceId: "surf-missing" },
        queryParams: { conversationId: "conv-unknown" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    // Rehydration must NOT have been called — otherwise an arbitrary
    // caller could materialize empty conversations for any UUID.
    expect(getOrCreateCalls).toEqual([]);
  });

  test("404s when the DB row's conversation_id mismatches the caller's", async () => {
    // The surface lives on a different conversation than the caller
    // claims. Refusing to rehydrate prevents cross-conversation
    // information leakage via guessable surfaceIds.
    memoryById = null;
    rawGetReturn = { conversation_id: "conv-actual-owner" };

    const handler = findHandler("surfaces_get_content");

    let caught: unknown;
    try {
      await handler({
        pathParams: { surfaceId: "surf-leaked" },
        queryParams: { conversationId: "conv-attacker" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(getOrCreateCalls).toEqual([]);
  });

  test("404s when rehydration succeeds but the surface still isn't present", async () => {
    // Adversarial sanity check: the DB scan found a row pointing at a
    // conversation, but after rehydration the surface neither lives in
    // surfaceState nor in currentTurnSurfaces. (Shouldn't really
    // happen given the scan keyed on the surfaceId — defensive.)
    memoryById = null;
    rawGetReturn = { conversation_id: "conv-evicted" };
    rehydrated = makeStub("conv-evicted"); // empty surfaceState

    const handler = findHandler("surfaces_get_content");

    let caught: unknown;
    try {
      await handler({
        pathParams: { surfaceId: "surf-gone" },
        queryParams: { conversationId: "conv-evicted" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    expect(getOrCreateCalls).toEqual(["conv-evicted"]);
  });
});

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
  trustContext?: { trustClass: string; sourceChannel: string };
  surfaceActionCalls: Array<{
    surfaceId: string;
    actionId: string;
    data: unknown;
    sourceActorPrincipalId?: string;
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

// Gateway guardian-delivery list (shared by the route's dev-bypass lookup and
// the local-principal-trust mapper): null = unreachable, [] = no guardian.
let mockGuardianList: Array<Record<string, unknown>> | null = [];
let httpAuthDisabled = false;

// Stub for the shared reset-drift helper. The route under test only consumes
// its result (a guardian TrustContext or null); the gate itself is covered in
// runtime/__tests__/guardian-vellum-migration.test.ts. Tests set
// `mockReResolve` per case and read `reResolveCalls` to assert routing.
const reResolveCalls: string[] = [];
let mockReResolve: { trustClass: string; sourceChannel: string } | null = null;

mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: (_input?: { channelTypes?: string[] }) =>
    Promise.resolve(mockGuardianList),
  peekCachedGuardianDelivery: () => mockGuardianList ?? undefined,
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

// Member ACL rides on memberRecord via the member-verdict cache; no local
// contact here.
mock.module("../../../contacts/contact-store.js", () => ({
  findContactByAddress: () => null,
}));

mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => httpAuthDisabled,
}));

mock.module("../../guardian-vellum-migration.js", () => ({
  reResolveTrustOnResetDrift: async (
    incomingPrincipalId: string,
    _sourceChannel: string,
  ) => {
    reResolveCalls.push(incomingPrincipalId);
    return mockReResolve;
  },
}));

mock.module("../../../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => {
    findConvCalls.push(id);
    return memoryById ?? undefined;
  },
  findConversationBySurfaceId: (surfaceId: string) => {
    findBySurfaceCalls.push(surfaceId);
    return memoryBySurface ?? undefined;
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

mock.module("../../../persistence/raw-query.js", () => ({
  rawGet: (_label: string, sql: string, ...params: unknown[]) => {
    rawGetCalls.push({ sql, params });
    return rawGetReturn;
  },
  // Consumed by the resolver module's persisted-history fallback
  // (`findPersistedSurfaceState`); the action routes never reach it, but
  // the mocked module must still provide every export the resolver
  // imports or the import itself fails.
  rawAll: () => [],
}));

// Mock guardian-action-service to cut off its deep transitive dependency chain.
// The apr:* routing is tested in guardian-routing-invariants.test.ts; this file
// focuses on the surface→conversation rehydration path.
mock.module("../../guardian-action-service.js", () => ({
  processGuardianDecision: async () => ({ ok: true, applied: true }),
}));

mock.module("../channel-route-shared.js", () => ({
  parseCallbackData: () => null,
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
      sourceActorPrincipalId?: string,
    ) => {
      stub.surfaceActionCalls.push({
        surfaceId,
        actionId,
        data,
        sourceActorPrincipalId,
      });
      if (stub.handleSurfaceActionThrows) throw stub.handleSurfaceActionThrows;
      return stub.handleSurfaceActionResult;
    },
    handleSurfaceUndo: (_surfaceId: string) => {
      stub.handleSurfaceUndoCalled = true;
      if (stub.handleSurfaceUndoThrows) throw stub.handleSurfaceUndoThrows;
    },
    setTrustContext: (ctx: { trustClass: string; sourceChannel: string }) => {
      stub.trustContext = ctx;
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
  mockGuardianList = [];
  httpAuthDisabled = false;
  reResolveCalls.length = 0;
  mockReResolve = null;
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
    expect(rawGetCalls[0]!.params).toEqual([`%"surfaceId":"surf-evicted"%`]);
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

  test("threads x-vellum-actor-principal-id into handleSurfaceAction", async () => {
    const live = makeStub("conv-principal");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-p", actionId: "act-p" },
      headers: { "x-vellum-actor-principal-id": "principal-committer" },
    });

    expect(live.surfaceActionCalls).toEqual([
      {
        surfaceId: "surf-p",
        actionId: "act-p",
        data: undefined,
        sourceActorPrincipalId: "principal-committer",
      },
    ]);
  });

  test("resolves dev-bypass to the guardian principal before threading the turn", async () => {
    httpAuthDisabled = true;
    mockGuardianList = [guardianDelivery(GUARDIAN_PRINCIPAL)];
    const live = makeStub("conv-dev-thread");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-dt", actionId: "act-dt" },
      headers: { "x-vellum-actor-principal-id": "dev-bypass" },
    });

    // dev-bypass is translated so the surface turn matches the SSE host-proxy
    // client's registered guardian principal (CU/app-control same-actor check).
    expect(live.surfaceActionCalls).toEqual([
      {
        surfaceId: "surf-dt",
        actionId: "act-dt",
        data: undefined,
        sourceActorPrincipalId: GUARDIAN_PRINCIPAL,
      },
    ]);
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
// Trust context resolution
// ---------------------------------------------------------------------------

const GUARDIAN_PRINCIPAL = "principal-guardian";
// Daemon-minted vellum-principal-* ids: the DB-reset drift signature. The
// gateway rebinds to a fresh id while the client still holds a JWT for the old.
const VELLUM_PRINCIPAL_OLD = "vellum-principal-old";
const VELLUM_PRINCIPAL_NEW = "vellum-principal-new";

function guardianDelivery(principalId: string): Record<string, unknown> {
  return {
    channelType: "vellum",
    contactId: "contact-1",
    principalId,
    address: "guardian-address",
    externalChatId: "guardian-chat",
    status: "active",
  };
}

// A guardian TrustContext the stubbed helper hands back on a recovered drift.
function guardianCtx(): { trustClass: string; sourceChannel: string } {
  return { trustClass: "guardian", sourceChannel: "vellum" };
}

describe("triggerSurfaceAction trust context", () => {
  test("guardian principal → guardian from the gateway binding, helper not called", async () => {
    mockGuardianList = [guardianDelivery(GUARDIAN_PRINCIPAL)];
    const live = makeStub("conv-guardian");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-g", actionId: "act-g" },
      headers: { "x-vellum-actor-principal-id": GUARDIAN_PRINCIPAL },
    });

    expect(live.trustContext?.trustClass).toBe("guardian");
    expect(live.trustContext?.sourceChannel).toBe("vellum");
    // First-pass resolve already granted guardian, so the drift helper is skipped.
    expect(reResolveCalls).toEqual([]);
  });

  test("unknown principal: helper consulted, null result stays unknown (fail closed)", async () => {
    mockGuardianList = [guardianDelivery(GUARDIAN_PRINCIPAL)];
    mockReResolve = null;
    const live = makeStub("conv-unknown");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-u", actionId: "act-u" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(reResolveCalls).toEqual([VELLUM_PRINCIPAL_OLD]);
    expect(live.trustContext?.trustClass).toBe("unknown");
  });

  test("reset drift: helper returns guardian → route adopts it", async () => {
    mockGuardianList = [guardianDelivery(VELLUM_PRINCIPAL_NEW)];
    mockReResolve = guardianCtx();
    const live = makeStub("conv-drift");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-d", actionId: "act-d" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(reResolveCalls).toEqual([VELLUM_PRINCIPAL_OLD]);
    expect(live.trustContext?.trustClass).toBe("guardian");
  });

  test("dev-bypass resolves the real guardian principal from the gateway, helper not called", async () => {
    httpAuthDisabled = true;
    mockGuardianList = [guardianDelivery(GUARDIAN_PRINCIPAL)];
    const live = makeStub("conv-dev");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-dev", actionId: "act-dev" },
      headers: { "x-vellum-actor-principal-id": "dev-bypass" },
    });

    // The synthetic dev-bypass principal is translated to the real guardian,
    // yielding a guardian trust context without consulting the drift helper.
    expect(live.trustContext?.trustClass).toBe("guardian");
    expect(reResolveCalls).toEqual([]);
  });

  test("dev-bypass with an empty gateway: helper null result → unknown (fail closed)", async () => {
    httpAuthDisabled = true;
    // The gateway has no active binding, so dev-bypass cannot translate to a
    // real guardian; the first-pass resolve is unknown and the helper, returning
    // null, leaves trust unknown.
    mockGuardianList = [];
    mockReResolve = null;
    const live = makeStub("conv-dev-fallback");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-devf", actionId: "act-devf" },
      headers: { "x-vellum-actor-principal-id": "dev-bypass" },
    });

    expect(live.trustContext?.trustClass).toBe("unknown");
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

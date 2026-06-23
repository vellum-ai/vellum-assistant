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
// Local-mirror guardian record: dev-bypass reads .contact.principalId; the
// post-heal local resolver reads .contact and .channel.
let mockGuardianRecord: {
  contact: Record<string, unknown>;
  channel?: Record<string, unknown>;
} | null = null;
let httpAuthDisabled = false;
// Tracks heal invocations; onHeal lets a test repair the local mirror to
// simulate the post-heal re-resolve matching.
const healCalls: string[] = [];
let healResult = false;
let onHeal: (() => void) | null = null;

mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: (_input?: { channelTypes?: string[] }) =>
    Promise.resolve(mockGuardianList),
  peekCachedGuardianDelivery: () => mockGuardianList ?? undefined,
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

mock.module("../../../contacts/contact-store.js", () => ({
  findGuardianForChannel: (_channelType: string) => mockGuardianRecord,
  findContactByAddress: () => null,
}));

mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => httpAuthDisabled,
}));

mock.module("../../guardian-vellum-migration.js", () => ({
  healGuardianBindingDrift: async (principalId: string) => {
    healCalls.push(principalId);
    onHeal?.();
    return healResult;
  },
  // Mirror the real helper against this file's mocked gateway/local-mirror
  // state so the route exercises the shared narrow-drift gate end-to-end.
  reResolveTrustOnResetDrift: async (
    incomingPrincipalId: string,
    sourceChannel: string,
  ) => {
    const gatewayPrincipal = mockGuardianList
      ? mockGuardianList.find(
          (g) => g.channelType === "vellum" && g.status === "active",
        )?.principalId
      : undefined;
    const isResetDrift =
      incomingPrincipalId.startsWith("vellum-principal-") &&
      typeof gatewayPrincipal === "string" &&
      gatewayPrincipal.startsWith("vellum-principal-") &&
      gatewayPrincipal !== incomingPrincipalId;
    if (!isResetDrift) return null;
    healCalls.push(incomingPrincipalId);
    onHeal?.();
    return {
      trustClass:
        mockGuardianRecord?.contact.principalId === incomingPrincipalId
          ? "guardian"
          : "unknown",
      sourceChannel,
    };
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

mock.module("../../../memory/raw-query.js", () => ({
  rawGet: (sql: string, ...params: unknown[]) => {
    rawGetCalls.push({ sql, params });
    return rawGetReturn;
  },
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
    ) => {
      stub.surfaceActionCalls.push({ surfaceId, actionId, data });
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
  mockGuardianRecord = null;
  httpAuthDisabled = false;
  healCalls.length = 0;
  healResult = false;
  onHeal = null;
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

// Local-mirror guardian record as returned by findGuardianForChannel and read
// by resolveActorTrust. The channel address equals the principal so the local
// resolver classifies it as guardian on the vellum channel.
function localGuardianRecord(principalId: string): {
  contact: Record<string, unknown>;
  channel: Record<string, unknown>;
} {
  return {
    contact: { principalId, displayName: "Guardian" },
    channel: {
      type: "vellum",
      address: principalId,
      externalChatId: "guardian-chat",
      status: "active",
    },
  };
}

describe("triggerSurfaceAction trust context", () => {
  test("guardian principal → guardian trust context from the gateway binding", async () => {
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
    expect(healCalls).toEqual([]);
  });

  test("unknown principal → unknown trust context", async () => {
    mockGuardianList = [guardianDelivery(GUARDIAN_PRINCIPAL)];
    const live = makeStub("conv-unknown");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-u", actionId: "act-u" },
      headers: { "x-vellum-actor-principal-id": "principal-other" },
    });

    expect(live.trustContext?.trustClass).toBe("unknown");
    // Neither principal is a vellum-principal-*, so the reset-drift gate is
    // closed and no heal runs.
    expect(healCalls).toEqual([]);
  });

  test("reset drift: heal repairs the local mirror → guardian from local re-resolve", async () => {
    // DB-reset signature: the gateway active guardian is a fresh vellum-principal
    // while the client holds a JWT for the old one. The gateway binding stays
    // mismatched, so the mapper returns unknown both before and after heal. Heal
    // repairs the local mirror; the post-heal re-resolve reads it and matches.
    mockGuardianList = [guardianDelivery(VELLUM_PRINCIPAL_NEW)];
    healResult = true;
    onHeal = () => {
      mockGuardianRecord = localGuardianRecord(VELLUM_PRINCIPAL_OLD);
    };
    const live = makeStub("conv-drift");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-d", actionId: "act-d" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(healCalls).toEqual([VELLUM_PRINCIPAL_OLD]);
    // Gateway binding never matched; guardian comes from the local mirror.
    expect(mockGuardianList).toEqual([guardianDelivery(VELLUM_PRINCIPAL_NEW)]);
    expect(live.trustContext?.trustClass).toBe("guardian");
  });

  test("reset drift second request: heal no-ops (false) but local mirror already matches → guardian", async () => {
    // Later requests in the drift window reuse the same stale JWT: the gateway
    // binding still mismatches, and heal returns false because the local mirror
    // was already repaired on the first request. The local re-resolve must run
    // regardless of heal's return and recover guardian trust.
    mockGuardianList = [guardianDelivery(VELLUM_PRINCIPAL_NEW)];
    mockGuardianRecord = localGuardianRecord(VELLUM_PRINCIPAL_OLD);
    healResult = false;
    const live = makeStub("conv-drift-2");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-d2", actionId: "act-d2" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(healCalls).toEqual([VELLUM_PRINCIPAL_OLD]);
    // Gateway binding never matched; guardian comes from the local mirror even
    // though no heal write occurred.
    expect(mockGuardianList).toEqual([guardianDelivery(VELLUM_PRINCIPAL_NEW)]);
    expect(live.trustContext?.trustClass).toBe("guardian");
  });

  test("fail-closed: revoked gateway guardian (empty list) blocks the local fallback → unknown", async () => {
    // The gateway authoritatively revoked the guardian (no active binding) while
    // the local mirror WOULD still grant guardian. With no active gateway
    // principal there is no reset signature, so trust stays unknown (fail closed).
    mockGuardianList = [];
    mockGuardianRecord = localGuardianRecord(VELLUM_PRINCIPAL_OLD);
    const live = makeStub("conv-revoked");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-rv", actionId: "act-rv" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(live.trustContext?.trustClass).toBe("unknown");
    expect(healCalls).toEqual([]);
  });

  test("fail-closed: non-active gateway guardian blocks the local fallback → unknown", async () => {
    // The gateway binding exists but is not active (e.g. pending revocation):
    // guardianForChannel filters it out, so there is no active reset principal
    // and the fallback stays closed.
    mockGuardianList = [
      { ...guardianDelivery(VELLUM_PRINCIPAL_NEW), status: "revoked" },
    ];
    mockGuardianRecord = localGuardianRecord(VELLUM_PRINCIPAL_OLD);
    const live = makeStub("conv-inactive");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-ia", actionId: "act-ia" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(live.trustContext?.trustClass).toBe("unknown");
    expect(healCalls).toEqual([]);
  });

  test("fail-closed: rebind to a real external identity blocks the local fallback → unknown", async () => {
    // The gateway active guardian principal is a real external id (not a
    // vellum-principal-*) that differs from the actor — a genuine rebind, not a
    // DB reset. The fallback must stay closed even though the local mirror would
    // grant guardian.
    mockGuardianList = [guardianDelivery(GUARDIAN_PRINCIPAL)];
    mockGuardianRecord = localGuardianRecord(VELLUM_PRINCIPAL_OLD);
    const live = makeStub("conv-rebind");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-rb", actionId: "act-rb" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(live.trustContext?.trustClass).toBe("unknown");
    expect(healCalls).toEqual([]);
  });

  test("fail-closed: unreachable gateway (null) blocks the local drift fallback → unknown", async () => {
    // Gateway unreadable: the mapper fails closed to unknown, and the local
    // mirror WOULD classify this principal as guardian. The drift fallback must
    // stay gated off a null read, so trust must remain unknown (fail closed).
    mockGuardianList = null;
    mockGuardianRecord = localGuardianRecord(VELLUM_PRINCIPAL_OLD);
    const live = makeStub("conv-fail-closed");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-fc", actionId: "act-fc" },
      headers: { "x-vellum-actor-principal-id": VELLUM_PRINCIPAL_OLD },
    });

    expect(live.trustContext?.trustClass).toBe("unknown");
    // No fallback ran: heal is skipped on a null read.
    expect(healCalls).toEqual([]);
  });

  test("dev-bypass resolves the real guardian principal from the gateway", async () => {
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
    // yielding a guardian trust context without any heal.
    expect(live.trustContext?.trustClass).toBe("guardian");
    expect(healCalls).toEqual([]);
  });

  test("dev-bypass with an empty gateway and stale local mirror → unknown (fail closed)", async () => {
    httpAuthDisabled = true;
    mockGuardianList = [];
    // Local store supplies the guardian principal for dev-bypass, but the gateway
    // has no active binding. With no active gateway principal there is no reset
    // signature, so the fallback stays closed and trust is unknown.
    mockGuardianRecord = {
      contact: { principalId: GUARDIAN_PRINCIPAL },
      channel: { type: "vellum", address: "stale-address", status: "active" },
    };
    const live = makeStub("conv-dev-fallback");
    memoryBySurface = live;

    const handler = findHandler("triggerSurfaceAction");
    await handler({
      body: { surfaceId: "surf-devf", actionId: "act-devf" },
      headers: { "x-vellum-actor-principal-id": "dev-bypass" },
    });

    expect(live.trustContext?.trustClass).toBe("unknown");
    expect(healCalls).toEqual([]);
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

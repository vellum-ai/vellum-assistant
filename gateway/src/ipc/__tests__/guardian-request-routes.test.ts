/**
 * Socket-level tests for the guardian_requests_* lifecycle IPC routes.
 *
 * Each request travels over a real Unix-domain-socket round-trip against a
 * real (temp-dir) gateway DB, exercising the routes exactly as the daemon
 * relay hits them: schema validation on the server, guardian-request-store
 * writes, and wire-shaped responses pinned by the shared contract.
 *
 * `guardian_requests_decide` is asserted ABSENT (unknown method): decisions
 * are not part of this route set.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GUARDIAN_REQUESTS_IPC_METHODS,
  GuardianRequestDeliveryListIpcResponseSchema,
  GuardianRequestDeliverySchema,
  GuardianRequestInScopeIpcResponseSchema,
  GuardianRequestListIpcResponseSchema,
  GuardianRequestSchema,
  SweepExpiredGuardianRequestsIpcResponseSchema,
} from "@vellumai/gateway-client";
import { eq } from "drizzle-orm";

import "../../__tests__/test-preload.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../../db/connection.js";
import { createGuardianRequest } from "../../db/guardian-request-store.js";
import { guardianRequestDeliveries, guardianRequests } from "../../db/schema.js";
import { guardianRequestRoutes } from "../guardian-request-handlers.js";
import { GatewayIpcServer } from "../server.js";

const METHODS = GUARDIAN_REQUESTS_IPC_METHODS;

const FUTURE = () => Date.now() + 10 * 60 * 1000;
const PAST = () => Date.now() - 10_000;

let server: GatewayIpcServer;
let socketDir: string;
let prevEnv: string | undefined;
let reqSeq = 0;

async function rpc(
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `rpc-${++reqSeq}`;
  const line = JSON.stringify({ id, method, params });
  return await new Promise((resolve, reject) => {
    const sock = connect(server.getSocketPath());
    let buf = "";
    sock.on("connect", () => sock.write(line + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on("error", reject);
  });
}

/** rpc() for calls expected to succeed; returns the unwrapped result. */
async function call(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const res = await rpc(method, params);
  if (res.error !== undefined) {
    throw new Error(`unexpected IPC error: ${String(res.error)}`);
  }
  return res.result;
}

/** Create a request over the socket; every decisionable kind needs a principal. */
async function createRequest(overrides: Record<string, unknown> = {}) {
  return GuardianRequestSchema.parse(
    await call(METHODS.create, {
      id: `req-${++reqSeq}`,
      kind: "access_request",
      guardianPrincipalId: "principal-1",
      ...overrides,
    }),
  );
}

function getRequestRow(id: string) {
  return getGatewayDb()
    .select()
    .from(guardianRequests)
    .where(eq(guardianRequests.id, id))
    .get();
}

function getDeliveryRow(id: string) {
  return getGatewayDb()
    .select()
    .from(guardianRequestDeliveries)
    .where(eq(guardianRequestDeliveries.id, id))
    .get();
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(guardianRequestDeliveries).run();
  getGatewayDb().delete(guardianRequests).run();

  socketDir = mkdtempSync(join(tmpdir(), "vellum-ipc-test-"));
  prevEnv = process.env.GATEWAY_IPC_SOCKET_DIR;
  process.env.GATEWAY_IPC_SOCKET_DIR = socketDir;
  // Disable the watchdog so the test has a single deterministic listener.
  server = new GatewayIpcServer(guardianRequestRoutes, {
    watchdogIntervalMs: 0,
  });
  server.start();
  // Wait for the listener to bind.
  const { existsSync } = await import("node:fs");
  for (let i = 0; i < 100 && !existsSync(server.getSocketPath()); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
});

afterEach(() => {
  server.stop();
  if (prevEnv === undefined) delete process.env.GATEWAY_IPC_SOCKET_DIR;
  else process.env.GATEWAY_IPC_SOCKET_DIR = prevEnv;
  rmSync(socketDir, { recursive: true, force: true });
  resetGatewayDb();
});

describe("route registration", () => {
  test("registers every contract method except decide, each with a schema", () => {
    const expected = Object.values(METHODS)
      .filter((m) => m !== METHODS.decide)
      .sort();
    expect(guardianRequestRoutes.map((r) => r.method).sort()).toEqual(expected);
    for (const route of guardianRequestRoutes) {
      expect(route.schema).toBeDefined();
    }
  });

  test("guardian_requests_decide is not registered (unknown method)", async () => {
    const res = await rpc(METHODS.decide, {
      id: "req-x",
      expectedStatus: "pending",
      status: "approved",
    });
    expect(res.statusCode).toBe(404);
    expect(res.errorCode).toBe("UNKNOWN_METHOD");
    expect(String(res.error)).toContain("Unknown method");
  });
});

describe("guardian_requests_create", () => {
  test("persists the row, preserves the caller-supplied id, generates a code", async () => {
    const created = await createRequest({
      id: "access-req-self-telegram-alice-123",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      requesterExternalUserId: "tg-user-1",
      questionText: "Can Alice reach you?",
    });

    expect(created.id).toBe("access-req-self-telegram-alice-123");
    expect(created.status).toBe("pending");
    expect(created.requestCode).toMatch(/^[0-9A-F]{6}$/);
    expect(created.sourceType).toBe("channel");

    const row = getRequestRow(created.id);
    expect(row?.kind).toBe("access_request");
    expect(row?.sourceConversationId).toBe("conv-1");
    expect(row?.guardianPrincipalId).toBe("principal-1");
    expect(row?.requestCode).toBe(created.requestCode);
  });

  test("honors a caller-supplied requestCode", async () => {
    const created = await createRequest({ requestCode: "ABC123" });
    expect(created.requestCode).toBe("ABC123");
    expect(getRequestRow(created.id)?.requestCode).toBe("ABC123");
  });

  test("computes sourceType from sourceChannel: phone→voice, vellum→desktop, else channel", async () => {
    const voice = await createRequest({
      kind: "pending_question",
      sourceChannel: "phone",
      requesterExternalUserId: "+15555550101",
    });
    const desktop = await createRequest({
      kind: "tool_approval",
      sourceChannel: "vellum",
      toolName: "bash",
    });
    const bare = await createRequest({});

    expect(voice.sourceType).toBe("voice");
    expect(desktop.sourceType).toBe("desktop");
    expect(bare.sourceType).toBe("channel");
  });

  test("rejects a create without guardianPrincipalId at the schema", async () => {
    // The contract requires guardianPrincipalId (every admitted kind is
    // decisionable), so the store-level integrity guard is unreachable over
    // IPC — the schema rejection is the pinned behavior.
    const res = await rpc(METHODS.create, {
      id: "req-no-principal",
      kind: "access_request",
    });
    expect(res.statusCode).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
    expect(getRequestRow("req-no-principal")).toBeUndefined();
  });
});

describe("guardian_requests_get / get_by_code", () => {
  test("get returns the wire DTO, null for unknown ids", async () => {
    const created = await createRequest({ sourceChannel: "telegram" });
    expect(await call(METHODS.get, { id: created.id })).toEqual(created);
    expect(await call(METHODS.get, { id: "nope" })).toBeNull();
  });

  test("get_by_code matches pending requests only", async () => {
    const created = await createRequest({});
    const code = created.requestCode!;

    const found = GuardianRequestSchema.parse(
      await call(METHODS.getByCode, { code }),
    );
    expect(found.id).toBe(created.id);

    await call(METHODS.update, {
      id: created.id,
      patch: { status: "approved" },
    });
    expect(await call(METHODS.getByCode, { code })).toBeNull();
  });
});

describe("legacy kinds", () => {
  test("rows outside the kind enum round-trip through get and list", async () => {
    // Not creatable over IPC (create restricts kind), but legacy/backfilled
    // rows can carry any kind and reads must still serialize them.
    createGuardianRequest({ id: "req-legacy", kind: "status_update" });

    const fetched = GuardianRequestSchema.parse(
      await call(METHODS.get, { id: "req-legacy" }),
    );
    expect(fetched.kind).toBe("status_update");

    const listed = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list),
    );
    expect(listed.map((r) => r.id)).toContain("req-legacy");
  });
});

describe("guardian_requests_list", () => {
  test("filters by the derived sourceType and by stored columns", async () => {
    const voice = await createRequest({
      kind: "pending_question",
      sourceChannel: "phone",
    });
    const desktop = await createRequest({
      kind: "tool_approval",
      sourceChannel: "vellum",
      toolName: "bash",
    });
    const channel = await createRequest({ sourceChannel: "telegram" });

    const all = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list, {}),
    );
    expect(all).toHaveLength(3);

    const omittedParams = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list),
    );
    expect(omittedParams).toHaveLength(3);

    const voiceOnly = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list, { sourceType: "voice" }),
    );
    expect(voiceOnly.map((r) => r.id)).toEqual([voice.id]);

    const desktopOnly = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list, { sourceType: "desktop" }),
    );
    expect(desktopOnly.map((r) => r.id)).toEqual([desktop.id]);

    const channelOnly = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list, { sourceType: "channel" }),
    );
    expect(channelOnly.map((r) => r.id)).toEqual([channel.id]);

    const byKind = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list, { kind: "tool_approval", toolName: "bash" }),
    );
    expect(byKind.map((r) => r.id)).toEqual([desktop.id]);

    await call(METHODS.update, { id: voice.id, patch: { status: "denied" } });
    const pending = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.list, { status: "pending" }),
    );
    expect(pending.map((r) => r.id).sort()).toEqual(
      [desktop.id, channel.id].sort(),
    );
  });
});

describe("guardian_requests_update", () => {
  test("applies the patch and acks", async () => {
    const created = await createRequest({});

    const ack = await call(METHODS.update, {
      id: created.id,
      patch: {
        status: "approved",
        answerText: "yes",
        decidedByPrincipalId: "principal-1",
        followupState: "inline_wait_active:123",
        expiresAt: 456,
      },
    });
    expect(ack).toEqual({ ok: true });

    const row = getRequestRow(created.id);
    expect(row?.status).toBe("approved");
    expect(row?.answerText).toBe("yes");
    expect(row?.decidedByPrincipalId).toBe("principal-1");
    expect(row?.followupState).toBe("inline_wait_active:123");
    expect(row?.expiresAt).toBe(456);

    // A nullable followupState patch clears the stamp.
    await call(METHODS.update, {
      id: created.id,
      patch: { followupState: null },
    });
    expect(getRequestRow(created.id)?.followupState).toBeNull();
  });
});

describe("guardian_requests_expire / reopen", () => {
  test("expire CAS-expires the request and bulk-expires its deliveries", async () => {
    const created = await createRequest({});
    const delivery = GuardianRequestDeliverySchema.parse(
      await call(METHODS.createDelivery, {
        requestId: created.id,
        destinationChannel: "telegram",
        destinationChatId: "chat-1",
      }),
    );

    expect(await call(METHODS.expire, { id: created.id })).toEqual({
      ok: true,
    });
    expect(getRequestRow(created.id)?.status).toBe("expired");
    expect(getDeliveryRow(delivery.id)?.status).toBe("expired");
  });

  test("reopen CAS-transitions fromStatus back to pending; a missed swap is a no-op", async () => {
    const created = await createRequest({});
    await call(METHODS.expire, { id: created.id });

    // Wrong fromStatus: acks without touching the row.
    expect(
      await call(METHODS.reopen, { id: created.id, fromStatus: "denied" }),
    ).toEqual({ ok: true });
    expect(getRequestRow(created.id)?.status).toBe("expired");

    expect(
      await call(METHODS.reopen, { id: created.id, fromStatus: "expired" }),
    ).toEqual({ ok: true });
    expect(getRequestRow(created.id)?.status).toBe("pending");
  });
});

describe("guardian_requests_expire_interaction_bound", () => {
  test("expires interaction-bound kinds unconditionally, persistent kinds only past deadline", async () => {
    const toolApproval = await createRequest({
      kind: "tool_approval",
      toolName: "bash",
    });
    const pendingQuestion = await createRequest({ kind: "pending_question" });
    const freshAccess = await createRequest({ expiresAt: FUTURE() });
    const staleAccess = await createRequest({ expiresAt: PAST() });

    expect(await call(METHODS.expireInteractionBound, {})).toEqual({
      expired: 3,
    });
    expect(getRequestRow(toolApproval.id)?.status).toBe("expired");
    expect(getRequestRow(pendingQuestion.id)?.status).toBe("expired");
    expect(getRequestRow(staleAccess.id)?.status).toBe("expired");
    expect(getRequestRow(freshAccess.id)?.status).toBe("pending");
  });

  test("accepts the omitted-params call shape", async () => {
    const toolApproval = await createRequest({
      kind: "tool_approval",
      toolName: "bash",
    });

    expect(await call(METHODS.expireInteractionBound)).toEqual({ expired: 1 });
    expect(getRequestRow(toolApproval.id)?.status).toBe("expired");
  });
});

describe("guardian_requests_sweep_expired", () => {
  test("expires past-deadline pending requests and returns their ids", async () => {
    const stale = await createRequest({ expiresAt: PAST() });
    const fresh = await createRequest({ expiresAt: FUTURE() });
    const noDeadline = await createRequest({});

    const swept = SweepExpiredGuardianRequestsIpcResponseSchema.parse(
      await call(METHODS.sweepExpired),
    );
    expect(swept.expired).toEqual([stale.id]);
    expect(getRequestRow(stale.id)?.status).toBe("expired");
    expect(getRequestRow(fresh.id)?.status).toBe("pending");
    expect(getRequestRow(noDeadline.id)?.status).toBe("pending");
  });

  test("honors an explicit `now`", async () => {
    const fresh = await createRequest({ expiresAt: FUTURE() });

    const swept = SweepExpiredGuardianRequestsIpcResponseSchema.parse(
      await call(METHODS.sweepExpired, { now: fresh.expiresAt! + 1 }),
    );
    expect(swept.expired).toEqual([fresh.id]);
    expect(getRequestRow(fresh.id)?.status).toBe("expired");
  });
});

describe("delivery routes: create / update / list", () => {
  test("create + update + list round-trip", async () => {
    const created = await createRequest({});

    const first = GuardianRequestDeliverySchema.parse(
      await call(METHODS.createDelivery, {
        id: "delivery-1",
        requestId: created.id,
        destinationChannel: "telegram",
        destinationChatId: "chat-1",
        destinationConversationId: "conv-9",
      }),
    );
    expect(first.id).toBe("delivery-1");
    expect(first.status).toBe("pending");

    const second = GuardianRequestDeliverySchema.parse(
      await call(METHODS.createDelivery, {
        requestId: created.id,
        destinationChannel: "slack",
        destinationChatId: "C123",
        status: "sent",
      }),
    );
    expect(second.status).toBe("sent");

    const ack = await call(METHODS.updateDelivery, {
      id: first.id,
      patch: { status: "sent", destinationMessageId: "msg-42" },
    });
    expect(ack).toEqual({ ok: true });
    expect(getDeliveryRow(first.id)?.status).toBe("sent");
    expect(getDeliveryRow(first.id)?.destinationMessageId).toBe("msg-42");

    const listed = GuardianRequestDeliveryListIpcResponseSchema.parse(
      await call(METHODS.listDeliveries, { requestId: created.id }),
    );
    expect(listed.map((d) => d.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});

describe("destination lookups", () => {
  test("get_by_destination_message resolves the pending request behind a delivered card", async () => {
    const created = await createRequest({});
    await call(METHODS.createDelivery, {
      requestId: created.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      destinationMessageId: "msg-7",
    });

    const found = GuardianRequestSchema.parse(
      await call(METHODS.getByDestinationMessage, {
        channel: "telegram",
        chatId: "chat-1",
        messageId: "msg-7",
      }),
    );
    expect(found.id).toBe(created.id);

    // Resolved requests no longer match (pending-only).
    await call(METHODS.update, {
      id: created.id,
      patch: { status: "approved" },
    });
    expect(
      await call(METHODS.getByDestinationMessage, {
        channel: "telegram",
        chatId: "chat-1",
        messageId: "msg-7",
      }),
    ).toBeNull();
  });

  test("list_pending_by_destination: chat form and conversation form with channel narrowing", async () => {
    const a = await createRequest({});
    const b = await createRequest({});
    await call(METHODS.createDelivery, {
      requestId: a.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      destinationConversationId: "conv-1",
    });
    await call(METHODS.createDelivery, {
      requestId: b.id,
      destinationChannel: "slack",
      destinationChatId: "chat-1",
      destinationConversationId: "conv-1",
    });

    const byChat = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.listPendingByDestination, {
        channel: "telegram",
        chatId: "chat-1",
      }),
    );
    expect(byChat.map((r) => r.id)).toEqual([a.id]);

    const byConversation = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.listPendingByDestination, {
        conversationId: "conv-1",
      }),
    );
    expect(byConversation.map((r) => r.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );

    const narrowed = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.listPendingByDestination, {
        conversationId: "conv-1",
        channel: "slack",
      }),
    );
    expect(narrowed.map((r) => r.id)).toEqual([b.id]);
  });
});

describe("scope reads", () => {
  test("list_pending_by_scope unions source + delivery matches, deduplicated", async () => {
    const bySource = await createRequest({ sourceConversationId: "conv-1" });
    const byDelivery = await createRequest({});
    const both = await createRequest({ sourceConversationId: "conv-1" });
    await call(METHODS.createDelivery, {
      requestId: byDelivery.id,
      destinationChannel: "telegram",
      destinationConversationId: "conv-1",
    });
    await call(METHODS.createDelivery, {
      requestId: both.id,
      destinationChannel: "telegram",
      destinationConversationId: "conv-1",
    });
    await createRequest({ sourceConversationId: "conv-other" });

    const scoped = GuardianRequestListIpcResponseSchema.parse(
      await call(METHODS.listPendingByScope, { conversationId: "conv-1" }),
    );
    expect(scoped.map((r) => r.id).sort()).toEqual(
      [bySource.id, byDelivery.id, both.id].sort(),
    );
  });

  test("in_scope matches by source or delivery, honoring channel narrowing", async () => {
    const created = await createRequest({ sourceConversationId: "conv-src" });
    await call(METHODS.createDelivery, {
      requestId: created.id,
      destinationChannel: "telegram",
      destinationConversationId: "conv-dst",
    });

    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ requestId: created.id, conversationId: "conv-src" }, true],
      [{ requestId: created.id, conversationId: "conv-dst" }, true],
      [
        {
          requestId: created.id,
          conversationId: "conv-dst",
          channel: "telegram",
        },
        true,
      ],
      [
        { requestId: created.id, conversationId: "conv-dst", channel: "slack" },
        false,
      ],
      [{ requestId: created.id, conversationId: "conv-nope" }, false],
      [{ requestId: "nope", conversationId: "conv-src" }, false],
    ];
    for (const [params, inScope] of cases) {
      expect(
        GuardianRequestInScopeIpcResponseSchema.parse(
          await call(METHODS.inScope, params),
        ),
      ).toEqual({ inScope });
    }
  });
});

describe("call-session + pending-question lookups", () => {
  test("get_by_call_session returns the latest pending request for the session", async () => {
    expect(
      await call(METHODS.getByCallSession, { callSessionId: "call-1" }),
    ).toBeNull();

    const created = await createRequest({
      kind: "pending_question",
      sourceChannel: "phone",
      callSessionId: "call-1",
    });
    const found = GuardianRequestSchema.parse(
      await call(METHODS.getByCallSession, { callSessionId: "call-1" }),
    );
    expect(found.id).toBe(created.id);

    await call(METHODS.update, { id: created.id, patch: { status: "denied" } });
    expect(
      await call(METHODS.getByCallSession, { callSessionId: "call-1" }),
    ).toBeNull();
  });

  test("get_by_pending_question resolves the linked request", async () => {
    const created = await createRequest({
      kind: "pending_question",
      sourceChannel: "phone",
      pendingQuestionId: "pq-1",
    });
    const found = GuardianRequestSchema.parse(
      await call(METHODS.getByPendingQuestion, { pendingQuestionId: "pq-1" }),
    );
    expect(found.id).toBe(created.id);
    expect(
      await call(METHODS.getByPendingQuestion, { pendingQuestionId: "pq-2" }),
    ).toBeNull();
  });
});

describe("schema rejection", () => {
  test("malformed params → 400 BAD_REQUEST without touching the store", async () => {
    const badCalls: Array<[string, Record<string, unknown>]> = [
      [METHODS.create, {}], // id, kind, guardianPrincipalId required
      [
        METHODS.create,
        { id: "req-x", kind: "not-a-kind", guardianPrincipalId: "p" },
      ],
      [METHODS.create, { id: "", kind: "access_request", guardianPrincipalId: "p" }],
      [METHODS.get, {}],
      [METHODS.getByCode, { code: "" }],
      [METHODS.list, { sourceType: "carrier-pigeon" }],
      [METHODS.update, { id: "req-x" }], // patch required
      [METHODS.update, { id: "req-x", patch: { status: "not-a-status" } }],
      [METHODS.reopen, { id: "req-x" }], // fromStatus required
      [METHODS.expire, {}],
      [METHODS.sweepExpired, { now: "yesterday" }],
      [METHODS.createDelivery, { requestId: "req-x" }], // channel required
      [METHODS.updateDelivery, { id: "d-1" }], // patch required
      [METHODS.listDeliveries, {}],
      [METHODS.getByDestinationMessage, { channel: "telegram", chatId: "c" }],
      [METHODS.listPendingByDestination, {}], // refine: conversationId or channel+chatId
      [METHODS.listPendingByDestination, { channel: "telegram" }],
      [METHODS.listPendingByScope, {}],
      [METHODS.inScope, { requestId: "req-x" }],
      [METHODS.getByCallSession, { callSessionId: "" }],
      [METHODS.getByPendingQuestion, {}],
    ];

    for (const [method, params] of badCalls) {
      const res = await rpc(method, params);
      expect(res.statusCode).toBe(400);
      expect(res.errorCode).toBe("BAD_REQUEST");
      expect(String(res.error)).toContain("Invalid params");
    }

    // Nothing was written by any of the rejected calls.
    expect(getGatewayDb().select().from(guardianRequests).all()).toHaveLength(
      0,
    );
    expect(
      getGatewayDb().select().from(guardianRequestDeliveries).all(),
    ).toHaveLength(0);
  });
});

/**
 * Tests for m0015-guardian-requests-backfill.
 *
 * Verifies that assistant `canonical_guardian_requests` rows are copied into
 * the gateway `guardian_requests` table with full field fidelity — assistant
 * `conversation_id` maps to gateway `source_conversation_id` and assistant
 * `source_type` has no gateway column — that `canonical_guardian_deliveries`
 * rows land in `guardian_request_deliveries` with FK integrity, that the
 * gateway wins id conflicts, that re-running is idempotent, that an
 * already-dropped source table yields "done", that IPC failure yields "skip"
 * and retries, and that the migration never writes to the assistant DB.
 * Uses the same fake-assistant-DB + real in-memory gateway-DB pattern as the
 * m0013 test.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";

import "./test-preload.js";

// ── Fake assistant DB ───────────────────────────────────────────────────────

type FakeRequest = {
  id: string;
  kind: string;
  source_type: string;
  source_channel: string | null;
  conversation_id: string | null;
  requester_external_user_id: string | null;
  requester_chat_id: string | null;
  guardian_external_user_id: string | null;
  guardian_principal_id: string | null;
  call_session_id: string | null;
  pending_question_id: string | null;
  question_text: string | null;
  request_code: string | null;
  tool_name: string | null;
  input_digest: string | null;
  command_preview: string | null;
  risk_level: string | null;
  activity_text: string | null;
  execution_target: string | null;
  requester_signals: string | null;
  request_trigger: string | null;
  status: string;
  answer_text: string | null;
  decided_by_external_user_id: string | null;
  decided_by_principal_id: string | null;
  followup_state: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

type FakeDelivery = {
  id: string;
  request_id: string;
  destination_channel: string;
  destination_conversation_id: string | null;
  destination_chat_id: string | null;
  destination_message_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
};

const fakeAssistantDb = {
  requests: new Map<string, FakeRequest>(),
  deliveries: new Map<string, FakeDelivery>(),
  hasRequestsTable: true,
  hasDeliveriesTable: true,
  failQuery: false,
  reset(): void {
    this.requests.clear();
    this.deliveries.clear();
    this.hasRequestsTable = true;
    this.hasDeliveriesTable = true;
    this.failQuery = false;
  },
};

const assistantDbRun = mock(async () => {
  throw new Error("m0015 must not write to the assistant DB");
});
const assistantDbExec = mock(async () => {
  throw new Error("m0015 must not write to the assistant DB");
});

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string, bind?: unknown[]) => {
    if (fakeAssistantDb.failQuery) {
      throw new Error("simulated IPC failure");
    }
    const lower = sql.toLowerCase();
    if (lower.includes("sqlite_master")) {
      const name = bind?.[0];
      if (name === "canonical_guardian_requests") {
        return fakeAssistantDb.hasRequestsTable ? [{ "1": 1 }] : [];
      }
      if (name === "canonical_guardian_deliveries") {
        return fakeAssistantDb.hasDeliveriesTable ? [{ "1": 1 }] : [];
      }
      return [];
    }
    if (lower.includes("from canonical_guardian_requests")) {
      return Array.from(fakeAssistantDb.requests.values());
    }
    if (lower.includes("from canonical_guardian_deliveries")) {
      return Array.from(fakeAssistantDb.deliveries.values());
    }
    return [];
  }),
  // The backfill is copy-only; any assistant write is a bug.
  assistantDbRun,
  assistantDbExec,
}));

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { guardianRequests, guardianRequestDeliveries } from "../db/schema.js";
import { MIGRATIONS } from "../db/data-migrations/index.js";
import {
  up as m0015Up,
  down as m0015Down,
} from "../db/data-migrations/m0015-guardian-requests-backfill.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(guardianRequestDeliveries).run();
  db.delete(guardianRequests).run();
  fakeAssistantDb.reset();
  assistantDbRun.mockClear();
  assistantDbExec.mockClear();
});

afterAll(() => {
  resetGatewayDb();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedAssistantRequest(
  opts: Partial<FakeRequest> & { id: string },
): void {
  fakeAssistantDb.requests.set(opts.id, {
    kind: "access_request",
    source_type: "channel",
    source_channel: "telegram",
    conversation_id: null,
    requester_external_user_id: null,
    requester_chat_id: null,
    guardian_external_user_id: null,
    guardian_principal_id: null,
    call_session_id: null,
    pending_question_id: null,
    question_text: null,
    request_code: null,
    tool_name: null,
    input_digest: null,
    command_preview: null,
    risk_level: null,
    activity_text: null,
    execution_target: null,
    requester_signals: null,
    request_trigger: null,
    status: "pending",
    answer_text: null,
    decided_by_external_user_id: null,
    decided_by_principal_id: null,
    followup_state: null,
    expires_at: null,
    created_at: 100,
    updated_at: 200,
    ...opts,
  });
}

function seedAssistantDelivery(
  opts: Partial<FakeDelivery> & { id: string; request_id: string },
): void {
  fakeAssistantDb.deliveries.set(opts.id, {
    destination_channel: "telegram",
    destination_conversation_id: null,
    destination_chat_id: null,
    destination_message_id: null,
    status: "pending",
    created_at: 100,
    updated_at: 200,
    ...opts,
  });
}

function seedGatewayRequest(
  opts: Partial<typeof guardianRequests.$inferInsert> & { id: string },
): void {
  getGatewayDb()
    .insert(guardianRequests)
    .values({
      kind: "access_request",
      sourceChannel: "telegram",
      status: "pending",
      createdAt: 100,
      updatedAt: 200,
      ...opts,
    })
    .run();
}

function seedGatewayDelivery(
  opts: Partial<typeof guardianRequestDeliveries.$inferInsert> & {
    id: string;
    requestId: string;
  },
): void {
  getGatewayDb()
    .insert(guardianRequestDeliveries)
    .values({
      destinationChannel: "telegram",
      status: "pending",
      createdAt: 100,
      updatedAt: 200,
      ...opts,
    })
    .run();
}

function gatewayRequestIds(): string[] {
  const rows = getGatewayDb()
    .$client.prepare("SELECT id FROM guardian_requests")
    .all() as { id: string }[];
  return rows.map((r) => r.id).sort();
}

function gatewayRequest(id: string): Record<string, unknown> | undefined {
  return getGatewayDb()
    .$client.prepare("SELECT * FROM guardian_requests WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

function gatewayDeliveries(): Record<string, unknown>[] {
  return getGatewayDb()
    .$client.prepare("SELECT * FROM guardian_request_deliveries ORDER BY id")
    .all() as Record<string, unknown>[];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0015-guardian-requests-backfill", () => {
  test("copies an in-flight request with full field fidelity", async () => {
    seedAssistantRequest({
      id: "req-1",
      kind: "pending_question",
      source_type: "voice",
      source_channel: "phone",
      conversation_id: "conv-9",
      requester_external_user_id: "u-7",
      requester_chat_id: "chat-7",
      guardian_external_user_id: "guardian-1",
      guardian_principal_id: "principal-1",
      call_session_id: "call-3",
      pending_question_id: "pq-4",
      question_text: "Let them in?",
      request_code: "ABQ7",
      tool_name: "bash",
      input_digest: "digest-1",
      command_preview: "ls -la",
      risk_level: "medium",
      activity_text: "Listing files",
      execution_target: "host",
      requester_signals: '{"isBot":false,"isStranger":true}',
      request_trigger: "admitted",
      status: "pending",
      answer_text: "yes",
      decided_by_external_user_id: "decider-1",
      decided_by_principal_id: "decider-principal-1",
      followup_state: "inline_wait_active:123",
      expires_at: 9_999_999,
      created_at: 42,
      updated_at: 43,
    });

    const result = await m0015Up();

    expect(result).toBe("done");
    const row = gatewayRequest("req-1")!;
    expect(row.kind).toBe("pending_question");
    expect(row.source_channel).toBe("phone");
    expect(row.source_conversation_id).toBe("conv-9");
    expect(row.requester_external_user_id).toBe("u-7");
    expect(row.requester_chat_id).toBe("chat-7");
    expect(row.guardian_external_user_id).toBe("guardian-1");
    expect(row.guardian_principal_id).toBe("principal-1");
    expect(row.call_session_id).toBe("call-3");
    expect(row.pending_question_id).toBe("pq-4");
    expect(row.question_text).toBe("Let them in?");
    expect(row.request_code).toBe("ABQ7");
    expect(row.tool_name).toBe("bash");
    expect(row.input_digest).toBe("digest-1");
    expect(row.command_preview).toBe("ls -la");
    expect(row.risk_level).toBe("medium");
    expect(row.activity_text).toBe("Listing files");
    expect(row.execution_target).toBe("host");
    expect(row.requester_signals).toBe('{"isBot":false,"isStranger":true}');
    expect(row.request_trigger).toBe("admitted");
    expect(row.status).toBe("pending");
    expect(row.answer_text).toBe("yes");
    expect(row.decided_by_external_user_id).toBe("decider-1");
    expect(row.decided_by_principal_id).toBe("decider-principal-1");
    expect(row.followup_state).toBe("inline_wait_active:123");
    expect(row.expires_at).toBe(9_999_999);
    expect(row.created_at).toBe(42);
    expect(row.updated_at).toBe(43);
    // The gateway derives source type from source_channel; no column exists.
    expect("source_type" in row).toBe(false);
    expect("conversation_id" in row).toBe(false);
  });

  test("copies every request and delivery row with the FK intact", async () => {
    seedAssistantRequest({ id: "req-1" });
    seedAssistantRequest({ id: "req-2", kind: "tool_approval" });
    seedAssistantDelivery({ id: "del-1", request_id: "req-1" });
    seedAssistantDelivery({
      id: "del-2",
      request_id: "req-2",
      destination_channel: "slack",
      destination_conversation_id: "conv-5",
      destination_chat_id: "chat-5",
      destination_message_id: "msg-5",
      status: "sent",
      created_at: 111,
      updated_at: 222,
    });

    const result = await m0015Up();

    expect(result).toBe("done");
    expect(gatewayRequestIds()).toEqual(["req-1", "req-2"]);
    const deliveries = gatewayDeliveries();
    expect(deliveries.map((r) => r.id)).toEqual(["del-1", "del-2"]);
    expect(deliveries[0]!.request_id).toBe("req-1");
    const del2 = deliveries[1]!;
    expect(del2.request_id).toBe("req-2");
    expect(del2.destination_channel).toBe("slack");
    expect(del2.destination_conversation_id).toBe("conv-5");
    expect(del2.destination_chat_id).toBe("chat-5");
    expect(del2.destination_message_id).toBe("msg-5");
    expect(del2.status).toBe("sent");
    expect(del2.created_at).toBe(111);
    expect(del2.updated_at).toBe(222);

    // FK is live: deleting a request cascades to its backfilled deliveries.
    getGatewayDb()
      .$client.prepare("DELETE FROM guardian_requests WHERE id = ?")
      .run("req-1");
    expect(gatewayDeliveries().map((r) => r.id)).toEqual(["del-2"]);
  });

  test("backfills a delivery whose request already lives gateway-side", async () => {
    seedGatewayRequest({ id: "req-1", status: "approved" });
    seedAssistantRequest({ id: "req-1", status: "pending" });
    seedAssistantDelivery({ id: "del-1", request_id: "req-1" });

    expect(await m0015Up()).toBe("done");

    expect(gatewayRequest("req-1")!.status).toBe("approved");
    expect(gatewayDeliveries().map((r) => r.id)).toEqual(["del-1"]);
  });

  test("never overwrites an existing gateway request row", async () => {
    seedGatewayRequest({ id: "req-1", status: "approved", updatedAt: 900 });
    seedAssistantRequest({ id: "req-1", status: "pending", updated_at: 200 });

    const result = await m0015Up();

    expect(result).toBe("done");
    const row = gatewayRequest("req-1")!;
    expect(row.status).toBe("approved");
    expect(row.updated_at).toBe(900);
  });

  test("never overwrites an existing gateway delivery row", async () => {
    seedGatewayRequest({ id: "req-1" });
    seedGatewayDelivery({
      id: "del-1",
      requestId: "req-1",
      status: "sent",
      updatedAt: 900,
    });
    seedAssistantRequest({ id: "req-1" });
    seedAssistantDelivery({
      id: "del-1",
      request_id: "req-1",
      status: "pending",
      updated_at: 200,
    });

    expect(await m0015Up()).toBe("done");

    const deliveries = gatewayDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe("sent");
    expect(deliveries[0]!.updated_at).toBe(900);
  });

  test("idempotent: running twice yields the same rows and values", async () => {
    seedAssistantRequest({ id: "req-1" });
    seedAssistantRequest({ id: "req-2", kind: "tool_grant_request" });
    seedAssistantDelivery({ id: "del-1", request_id: "req-1" });

    expect(await m0015Up()).toBe("done");
    const firstRun = {
      ids: gatewayRequestIds(),
      req1: gatewayRequest("req-1"),
      deliveries: gatewayDeliveries(),
    };
    expect(await m0015Up()).toBe("done");

    expect(gatewayRequestIds()).toEqual(firstRun.ids);
    expect(gatewayRequest("req-1")).toEqual(firstRun.req1);
    expect(gatewayDeliveries()).toEqual(firstRun.deliveries);
  });

  test("returns done when the assistant requests table is already dropped", async () => {
    fakeAssistantDb.hasRequestsTable = false;
    seedAssistantDelivery({ id: "del-1", request_id: "req-1" });

    const result = await m0015Up();

    expect(result).toBe("done");
    expect(gatewayRequestIds()).toEqual([]);
    expect(gatewayDeliveries()).toEqual([]);
  });

  test("copies requests even when the deliveries table is absent", async () => {
    fakeAssistantDb.hasDeliveriesTable = false;
    seedAssistantRequest({ id: "req-1" });

    const result = await m0015Up();

    expect(result).toBe("done");
    expect(gatewayRequestIds()).toEqual(["req-1"]);
    expect(gatewayDeliveries()).toEqual([]);
  });

  test("returns skip on IPC failure, then completes on retry", async () => {
    seedAssistantRequest({ id: "req-1" });
    fakeAssistantDb.failQuery = true;

    expect(await m0015Up()).toBe("skip");
    expect(gatewayRequestIds()).toEqual([]);

    fakeAssistantDb.failQuery = false;
    expect(await m0015Up()).toBe("done");
    expect(gatewayRequestIds()).toEqual(["req-1"]);
  });

  test("never writes to the assistant DB (copy, not move)", async () => {
    seedAssistantRequest({ id: "req-1" });
    seedAssistantDelivery({ id: "del-1", request_id: "req-1" });

    expect(await m0015Up()).toBe("done");

    expect(assistantDbRun).toHaveBeenCalledTimes(0);
    expect(assistantDbExec).toHaveBeenCalledTimes(0);
    expect(fakeAssistantDb.requests.has("req-1")).toBe(true);
    expect(fakeAssistantDb.deliveries.has("del-1")).toBe(true);
  });

  test("is registered after m0014", () => {
    const keys = MIGRATIONS.map((m) => m.key);
    const m0014Index = keys.indexOf("m0014-drop-assistant-verification-tables");
    const m0015Index = keys.indexOf("m0015-guardian-requests-backfill");

    expect(m0014Index).toBeGreaterThanOrEqual(0);
    expect(m0015Index).toBe(m0014Index + 1);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0015Down()).toBe("done");
  });
});

/**
 * Tests for m0016-drop-assistant-guardian-tables.
 *
 * Verifies that the drops are gated on m0015's one_time_migrations checkpoint
 * (nothing is copied or dropped until the backfill is recorded as done), that
 * the final catch-up copy pass lands late assistant rows gateway-side — with
 * the conversation_id → source_conversation_id rename and the null-channel
 * sentinel mapping — before anything is dropped, that all five assistant
 * tables are dropped via the IPC db proxy in FK order, that an IPC failure
 * returns "skip" (runner retries next boot), that the migration is
 * idempotent, and that it is registered after m0015. Uses the same
 * fake-assistant-DB + real in-memory gateway-DB pattern as the m0014/m0015
 * tests.
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
  source_type: string | null;
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

const ALL_TABLES = [
  "canonical_guardian_deliveries",
  "canonical_guardian_requests",
  "guardian_action_deliveries",
  "guardian_action_requests",
  "channel_guardian_approval_requests",
];

const fakeAssistantDb = {
  tables: new Set<string>(),
  requests: new Map<string, FakeRequest>(),
  deliveries: new Map<string, FakeDelivery>(),
  failQuery: false,
  failDrop: false,
  dropCalls: [] as string[],
  reset(): void {
    this.tables = new Set(ALL_TABLES);
    this.requests.clear();
    this.deliveries.clear();
    this.failQuery = false;
    this.failDrop = false;
    this.dropCalls = [];
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string, bind?: unknown[]) => {
    if (fakeAssistantDb.failQuery) {
      throw new Error("simulated IPC failure");
    }
    const lower = sql.toLowerCase();
    if (lower.includes("sqlite_master")) {
      return fakeAssistantDb.tables.has(String(bind?.[0])) ? [{ "1": 1 }] : [];
    }
    if (lower.includes("from canonical_guardian_requests")) {
      const rows = Array.from(fakeAssistantDb.requests.values());
      // The decision-carry pass selects only terminal rows.
      if (lower.includes("status != 'pending'")) {
        return rows.filter((row) => row.status !== "pending");
      }
      return rows;
    }
    if (lower.includes("from canonical_guardian_deliveries")) {
      return Array.from(fakeAssistantDb.deliveries.values());
    }
    return [];
  }),
  assistantDbRun: mock(async (sql: string) => {
    const match = sql.match(/DROP TABLE IF EXISTS (\w+)/i);
    if (match) {
      fakeAssistantDb.dropCalls.push(match[1]);
      if (fakeAssistantDb.failDrop) {
        throw new Error("IPC transport failure");
      }
      fakeAssistantDb.tables.delete(match[1]);
    }
    return { changes: 0, lastInsertRowid: 0 };
  }),
  assistantDbExec: mock(async () => undefined),
}));

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import {
  guardianRequests,
  guardianRequestDeliveries,
  oneTimeMigrations,
} from "../db/schema.js";
import { MIGRATIONS } from "../db/data-migrations/index.js";
import {
  up as m0016Up,
  down as m0016Down,
  M0015_CHECKPOINT_KEY,
} from "../db/data-migrations/m0016-drop-assistant-guardian-tables.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(guardianRequestDeliveries).run();
  db.delete(guardianRequests).run();
  db.delete(oneTimeMigrations).run();
  fakeAssistantDb.reset();
  checkpointM0015();
});

afterAll(() => {
  resetGatewayDb();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function checkpointM0015(): void {
  getGatewayDb()
    .insert(oneTimeMigrations)
    .values({ key: M0015_CHECKPOINT_KEY, ranAt: 1_000 })
    .run();
}

function uncheckpointM0015(): void {
  getGatewayDb().delete(oneTimeMigrations).run();
}

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

function gatewayRequest(id: string): Record<string, unknown> | undefined {
  return (
    (getGatewayDb()
      .$client.prepare("SELECT * FROM guardian_requests WHERE id = ?")
      .get(id) as Record<string, unknown> | null) ?? undefined
  );
}

function gatewayDeliveryIds(): string[] {
  const rows = getGatewayDb()
    .$client.prepare("SELECT id FROM guardian_request_deliveries ORDER BY id")
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0016-drop-assistant-guardian-tables", () => {
  test("skips entirely (no copy, no drops) when m0015 is not checkpointed", async () => {
    uncheckpointM0015();
    seedAssistantRequest({ id: "req-late" });

    const result = await m0016Up();

    expect(result).toBe("skip");
    expect(fakeAssistantDb.dropCalls).toEqual([]);
    expect(fakeAssistantDb.tables.size).toBe(5);
    expect(gatewayRequest("req-late")).toBeUndefined();

    // Once the checkpoint lands, the same boot-retry path completes.
    checkpointM0015();
    expect(await m0016Up()).toBe("done");
    expect(fakeAssistantDb.tables.size).toBe(0);
    expect(gatewayRequest("req-late")).toBeDefined();
  });

  test("catch-up copies late assistant rows before dropping, mapping renamed columns", async () => {
    seedAssistantRequest({
      id: "req-late",
      conversation_id: "conv-9",
      request_code: "ABQ7",
      status: "pending",
    });
    seedAssistantDelivery({
      id: "del-late",
      request_id: "req-late",
      destination_channel: "slack",
      destination_conversation_id: "conv-5",
    });

    const result = await m0016Up();

    expect(result).toBe("done");
    const row = gatewayRequest("req-late")!;
    expect(row.source_conversation_id).toBe("conv-9");
    expect(row.request_code).toBe("ABQ7");
    expect("conversation_id" in row).toBe(false);
    expect("source_type" in row).toBe(false);
    expect(gatewayDeliveryIds()).toEqual(["del-late"]);
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("catch-up applies the sentinel channel to null-channel desktop/voice rows", async () => {
    seedAssistantRequest({
      id: "req-desktop",
      source_type: "desktop",
      source_channel: null,
    });
    seedAssistantRequest({
      id: "req-voice",
      source_type: "voice",
      source_channel: null,
    });

    expect(await m0016Up()).toBe("done");
    expect(gatewayRequest("req-desktop")!.source_channel).toBe("vellum");
    expect(gatewayRequest("req-voice")!.source_channel).toBe("phone");
  });

  test("catch-up never overwrites an existing gateway row", async () => {
    getGatewayDb()
      .insert(guardianRequests)
      .values({
        id: "req-1",
        kind: "access_request",
        sourceChannel: "telegram",
        status: "approved",
        createdAt: 100,
        updatedAt: 900,
      })
      .run();
    seedAssistantRequest({ id: "req-1", status: "pending", updated_at: 200 });

    expect(await m0016Up()).toBe("done");

    const row = gatewayRequest("req-1")!;
    expect(row.status).toBe("approved");
    expect(row.updated_at).toBe(900);
  });

  test("carries a late assistant-side decision onto a still-pending gateway row", async () => {
    getGatewayDb()
      .insert(guardianRequests)
      .values({
        id: "req-decided-late",
        kind: "access_request",
        sourceChannel: "telegram",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      })
      .run();
    seedAssistantRequest({
      id: "req-decided-late",
      status: "approved",
      answer_text: "yes",
      decided_by_external_user_id: "guardian-1",
      decided_by_principal_id: "principal-1",
      followup_state: "notified",
      updated_at: 500,
    });

    expect(await m0016Up()).toBe("done");

    const row = gatewayRequest("req-decided-late")!;
    expect(row.status).toBe("approved");
    expect(row.answer_text).toBe("yes");
    expect(row.decided_by_external_user_id).toBe("guardian-1");
    expect(row.decided_by_principal_id).toBe("principal-1");
    expect(row.followup_state).toBe("notified");
    expect(row.updated_at).toBe(500);
  });

  test("never carries an assistant decision over a decided gateway row", async () => {
    getGatewayDb()
      .insert(guardianRequests)
      .values({
        id: "req-gw-decided",
        kind: "access_request",
        sourceChannel: "telegram",
        status: "denied",
        createdAt: 100,
        updatedAt: 900,
      })
      .run();
    seedAssistantRequest({
      id: "req-gw-decided",
      status: "approved",
      updated_at: 950,
    });

    expect(await m0016Up()).toBe("done");

    const row = gatewayRequest("req-gw-decided")!;
    expect(row.status).toBe("denied");
    expect(row.updated_at).toBe(900);
  });

  test("drops all five assistant tables in FK order once m0015 is checkpointed", async () => {
    const result = await m0016Up();

    expect(result).toBe("done");
    expect(fakeAssistantDb.dropCalls).toEqual([
      "canonical_guardian_deliveries",
      "canonical_guardian_requests",
      "guardian_action_deliveries",
      "guardian_action_requests",
      "channel_guardian_approval_requests",
    ]);
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("returns skip when the catch-up copy fails, dropping nothing", async () => {
    seedAssistantRequest({ id: "req-late" });
    fakeAssistantDb.failQuery = true;

    expect(await m0016Up()).toBe("skip");
    expect(fakeAssistantDb.dropCalls).toEqual([]);
    expect(fakeAssistantDb.tables.size).toBe(5);

    // Retry after the IPC path recovers copies and drops.
    fakeAssistantDb.failQuery = false;
    expect(await m0016Up()).toBe("done");
    expect(gatewayRequest("req-late")).toBeDefined();
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("returns skip on drop IPC failure so the runner retries next boot", async () => {
    seedAssistantRequest({ id: "req-late" });
    fakeAssistantDb.failDrop = true;

    const result = await m0016Up();

    expect(result).toBe("skip");
    // The catch-up copy already landed; the retry only redoes the drops.
    expect(gatewayRequest("req-late")).toBeDefined();
    expect(fakeAssistantDb.tables.size).toBe(5);

    fakeAssistantDb.failDrop = false;
    expect(await m0016Up()).toBe("done");
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("idempotent: running twice yields the same state", async () => {
    seedAssistantRequest({ id: "req-late" });

    expect(await m0016Up()).toBe("done");
    expect(await m0016Up()).toBe("done");
    expect(fakeAssistantDb.tables.size).toBe(0);
    expect(gatewayRequest("req-late")).toBeDefined();
  });

  test("is registered after m0015 and gates on m0015's registered checkpoint key", () => {
    const keys = MIGRATIONS.map((m) => m.key);
    const backfillIndex = keys.indexOf(M0015_CHECKPOINT_KEY);
    const dropIndex = keys.indexOf("m0016-drop-assistant-guardian-tables");

    expect(backfillIndex).toBeGreaterThanOrEqual(0);
    expect(dropIndex).toBe(backfillIndex + 1);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0016Down()).toBe("done");
  });
});

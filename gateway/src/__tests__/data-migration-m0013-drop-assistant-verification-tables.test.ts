/**
 * Tests for m0013-drop-assistant-verification-tables.
 *
 * Verifies that the drops are gated on m0012's one_time_migrations checkpoint
 * (nothing is dropped until the backfill is recorded as done), that both
 * assistant tables are dropped via the IPC db proxy once the checkpoint
 * lands, that an IPC failure returns "skip" (runner retries next boot), that
 * the migration is idempotent, and that it is registered after m0012. Uses
 * the same fake-assistant-DB + real in-memory gateway-DB pattern as the
 * m0010 test.
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

const fakeAssistantDb = {
  tables: new Set<string>(),
  failDrop: false,
  dropCalls: [] as string[],
  reset(): void {
    this.tables = new Set([
      "channel_verification_sessions",
      "channel_guardian_rate_limits",
    ]);
    this.failDrop = false;
    this.dropCalls = [];
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async () => []),
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
import { oneTimeMigrations } from "../db/schema.js";
import { MIGRATIONS } from "../db/data-migrations/index.js";
import {
  up as m0013Up,
  down as m0013Down,
  M0012_CHECKPOINT_KEY,
} from "../db/data-migrations/m0013-drop-assistant-verification-tables.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(oneTimeMigrations).run();
  fakeAssistantDb.reset();
  checkpointM0012();
});

afterAll(() => {
  resetGatewayDb();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function checkpointM0012(): void {
  getGatewayDb()
    .insert(oneTimeMigrations)
    .values({ key: M0012_CHECKPOINT_KEY, ranAt: 1_000 })
    .run();
}

function uncheckpointM0012(): void {
  getGatewayDb().delete(oneTimeMigrations).run();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0013-drop-assistant-verification-tables", () => {
  test("skips entirely (no drops) when m0012 is not checkpointed", async () => {
    uncheckpointM0012();

    const result = await m0013Up();

    expect(result).toBe("skip");
    expect(fakeAssistantDb.dropCalls).toEqual([]);
    expect(fakeAssistantDb.tables.size).toBe(2);

    // Once the checkpoint lands, the same boot-retry path completes.
    checkpointM0012();
    expect(await m0013Up()).toBe("done");
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("drops both assistant tables once m0012 is checkpointed", async () => {
    const result = await m0013Up();

    expect(result).toBe("done");
    expect(fakeAssistantDb.dropCalls).toEqual([
      "channel_verification_sessions",
      "channel_guardian_rate_limits",
    ]);
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("returns skip on IPC failure so the runner retries next boot", async () => {
    fakeAssistantDb.failDrop = true;

    const result = await m0013Up();

    expect(result).toBe("skip");
    expect(fakeAssistantDb.tables.size).toBe(2);

    // Retry after the IPC path recovers completes both drops.
    fakeAssistantDb.failDrop = false;
    expect(await m0013Up()).toBe("done");
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("idempotent: running twice yields the same state", async () => {
    expect(await m0013Up()).toBe("done");
    expect(await m0013Up()).toBe("done");
    expect(fakeAssistantDb.tables.size).toBe(0);
  });

  test("is registered after m0012 and gates on m0012's registered checkpoint key", () => {
    const keys = MIGRATIONS.map((m) => m.key);
    const backfillIndex = keys.indexOf(M0012_CHECKPOINT_KEY);
    const dropIndex = keys.indexOf("m0013-drop-assistant-verification-tables");

    expect(backfillIndex).toBeGreaterThanOrEqual(0);
    expect(dropIndex).toBeGreaterThan(backfillIndex);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0013Down()).toBe("done");
  });
});

/**
 * Tests for m0011-drop-gw-verification-sessions.
 *
 * Verifies that the gateway `channel_verification_sessions` mirror table is
 * dropped when present, that re-running is idempotent, that a fresh install
 * (table already absent) is a no-op that still reports "done", that down() is
 * a no-op, and that the migration is registered after m0010.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";

import "./test-preload.js";

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { MIGRATIONS } from "../db/data-migrations/index.js";
import {
  up as m0011Up,
  down as m0011Down,
} from "../db/data-migrations/m0011-drop-gw-verification-sessions.js";

beforeAll(async () => {
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

function rawDb() {
  return getGatewayDb().$client;
}

function tableExists(): boolean {
  const row = rawDb()
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_verification_sessions'",
    )
    .get();
  return row != null;
}

function createMirrorTable(): void {
  rawDb().exec(
    "CREATE TABLE IF NOT EXISTS channel_verification_sessions (id TEXT PRIMARY KEY, status TEXT)",
  );
}

beforeEach(() => {
  createMirrorTable();
});

describe("m0011-drop-gw-verification-sessions", () => {
  test("drops the mirror table when present", () => {
    expect(tableExists()).toBe(true);

    expect(m0011Up()).toBe("done");

    expect(tableExists()).toBe(false);
  });

  test("idempotent: re-running after the drop is a no-op", () => {
    expect(m0011Up()).toBe("done");
    expect(tableExists()).toBe(false);

    expect(m0011Up()).toBe("done");
    expect(tableExists()).toBe(false);
  });

  test("fresh install (table absent) is a no-op that reports done", () => {
    rawDb().exec("DROP TABLE IF EXISTS channel_verification_sessions");
    expect(tableExists()).toBe(false);

    expect(m0011Up()).toBe("done");
    expect(tableExists()).toBe(false);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0011Down()).toBe("done");
  });

  test("is registered after m0010", () => {
    const keys = MIGRATIONS.map((m) => m.key);
    const prevIndex = keys.indexOf("m0010-drop-assistant-ingress-invites");
    const thisIndex = keys.indexOf("m0011-drop-gw-verification-sessions");

    expect(prevIndex).toBeGreaterThanOrEqual(0);
    expect(thisIndex).toBeGreaterThan(prevIndex);
  });
});

/**
 * Tests for m0011-drop-gw-verification-sessions (retired to a no-op).
 *
 * The migration formerly dropped the gateway `channel_verification_sessions`
 * write-only mirror. Combo 13 recreates that table as gateway-owned via the
 * schema push, so the drop was retired: up() must leave the live table
 * intact on installs that never recorded the key (fresh installs run data
 * migrations after the schema push creates the table).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

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

function tableExists(): boolean {
  const row = getGatewayDb()
    .$client.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_verification_sessions'",
    )
    .get();
  return row != null;
}

describe("m0011-drop-gw-verification-sessions", () => {
  test("up is a no-op that leaves the gateway-owned table intact", () => {
    // Schema push at initGatewayDb created the recreated table.
    expect(tableExists()).toBe(true);

    expect(m0011Up()).toBe("done");
    expect(tableExists()).toBe(true);

    // Idempotent re-run.
    expect(m0011Up()).toBe("done");
    expect(tableExists()).toBe(true);
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

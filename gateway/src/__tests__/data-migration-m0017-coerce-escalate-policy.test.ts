/**
 * Tests for m0017-coerce-escalate-policy.
 *
 * Verifies that only contact_channels rows with policy='escalate' are
 * coerced to 'deny' (allow/deny rows untouched byte-for-byte, updated_at
 * included), that coerced rows get a fresh updated_at stamp, that a re-run
 * coerces zero rows (idempotent), that the migration is registered after
 * m0016, and that down() is a no-op. Uses the real in-memory gateway DB;
 * this migration never touches the assistant DB.
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

// Record info output. Real logger exports are preserved; the migration
// module loads dynamically below, after this mock, so its module-level
// `log` binds to the recorder.
const realLogger = await import("../logger.js");
const infoLogs: unknown[][] = [];
const recordingLog = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  info: (...args: unknown[]) => {
    infoLogs.push(args);
  },
};
mock.module("../logger.js", () => ({
  ...realLogger,
  getLogger: () => recordingLog,
}));

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

const { MIGRATIONS } = await import("../db/data-migrations/index.js");
const { up: m0017Up, down: m0017Down } =
  await import("../db/data-migrations/m0017-coerce-escalate-policy.js");

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  infoLogs.length = 0;
});

afterAll(() => {
  resetGatewayDb();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedChannel(id: string, policy: string, updatedAt: number): void {
  const db = getGatewayDb();
  db.insert(contacts)
    .values({
      id: `contact-${id}`,
      displayName: `Contact ${id}`,
      createdAt: 100,
      updatedAt: 100,
    })
    .run();
  db.insert(contactChannels)
    .values({
      id,
      contactId: `contact-${id}`,
      type: "telegram",
      address: `addr-${id}`,
      status: "active",
      policy,
      createdAt: 100,
      updatedAt,
    })
    .run();
}

function channelRow(id: string): Record<string, unknown> {
  return getGatewayDb()
    .$client.prepare("SELECT * FROM contact_channels WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0017-coerce-escalate-policy", () => {
  test("coerces only escalate rows to deny and stamps their updated_at", () => {
    seedChannel("ch-allow", "allow", 111);
    seedChannel("ch-deny", "deny", 222);
    seedChannel("ch-escalate", "escalate", 333);
    const allowBefore = channelRow("ch-allow");
    const denyBefore = channelRow("ch-deny");
    const before = Date.now();

    expect(m0017Up()).toBe("done");

    const coerced = channelRow("ch-escalate");
    expect(coerced.policy).toBe("deny");
    expect(coerced.updated_at as number).toBeGreaterThanOrEqual(before);

    // allow/deny rows are byte-for-byte untouched, updated_at included.
    expect(channelRow("ch-allow")).toEqual(allowBefore);
    expect(channelRow("ch-deny")).toEqual(denyBefore);
  });

  test("idempotent: a re-run coerces zero rows", () => {
    seedChannel("ch-escalate", "escalate", 333);

    expect(m0017Up()).toBe("done");
    const afterFirst = channelRow("ch-escalate");

    expect(m0017Up()).toBe("done");
    expect(channelRow("ch-escalate")).toEqual(afterFirst);
  });

  test("no-op on a DB with no escalate rows", () => {
    seedChannel("ch-allow", "allow", 111);
    const allowBefore = channelRow("ch-allow");

    expect(m0017Up()).toBe("done");
    expect(channelRow("ch-allow")).toEqual(allowBefore);
  });

  test("logs the coerced count (no silent data change)", () => {
    seedChannel("ch-escalate-1", "escalate", 111);
    seedChannel("ch-escalate-2", "escalate", 222);

    expect(m0017Up()).toBe("done");
    const coercionLog = infoLogs.find(
      (args) =>
        typeof args[0] === "object" &&
        args[0] !== null &&
        (args[0] as { coerced?: number }).coerced === 2,
    );
    expect(coercionLog).toBeDefined();

    // A run that coerces nothing stays silent.
    infoLogs.length = 0;
    expect(m0017Up()).toBe("done");
    expect(
      infoLogs.some(
        (args) =>
          typeof args[0] === "object" &&
          args[0] !== null &&
          "coerced" in (args[0] as object),
      ),
    ).toBe(false);
  });

  test("is registered directly after m0016", () => {
    const keys = MIGRATIONS.map((m) => m.key);
    const m0016Index = keys.indexOf("m0016-drop-assistant-guardian-tables");
    const m0017Index = keys.indexOf("m0017-coerce-escalate-policy");

    expect(m0016Index).toBeGreaterThanOrEqual(0);
    expect(m0017Index).toBe(m0016Index + 1);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0017Down()).toBe("done");
  });
});

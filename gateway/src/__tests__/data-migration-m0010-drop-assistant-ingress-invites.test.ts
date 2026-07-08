/**
 * Tests for m0010-drop-assistant-ingress-invites.
 *
 * Verifies that the whole migration is gated on m0009's one_time_migrations
 * checkpoint (no purge, no drop until the backfill is recorded as done), that
 * phantom a2a rows (copied into the gateway by m0007) are purged from gateway
 * `ingress_invites`, that the assistant `assistant_ingress_invites` table is
 * dropped via the IPC db proxy, that an IPC failure returns "skip" (runner
 * retries next boot) while the a2a purge still applies, that the migration is
 * idempotent, and that it is registered after m0009. Uses the same
 * fake-assistant-DB + real in-memory gateway-DB pattern as the m0007/m0009
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

const fakeAssistantDb = {
  hasInvitesTable: true,
  failDrop: false,
  dropCalls: 0,
  reset(): void {
    this.hasInvitesTable = true;
    this.failDrop = false;
    this.dropCalls = 0;
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async () => []),
  assistantDbRun: mock(async (sql: string) => {
    if (
      sql.toLowerCase().includes("drop table") &&
      sql.includes("assistant_ingress_invites")
    ) {
      fakeAssistantDb.dropCalls += 1;
      if (fakeAssistantDb.failDrop) {
        throw new Error("IPC transport failure");
      }
      fakeAssistantDb.hasInvitesTable = false;
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
import { contacts, ingressInvites, oneTimeMigrations } from "../db/schema.js";
import { MIGRATIONS } from "../db/data-migrations/index.js";
import {
  up as m0010Up,
  down as m0010Down,
  M0009_CHECKPOINT_KEY,
} from "../db/data-migrations/m0010-drop-assistant-ingress-invites.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contacts).run();
  db.delete(oneTimeMigrations).run();
  fakeAssistantDb.reset();
  checkpointM0009();
});

afterAll(() => {
  resetGatewayDb();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function checkpointM0009(): void {
  getGatewayDb()
    .insert(oneTimeMigrations)
    .values({ key: M0009_CHECKPOINT_KEY, ranAt: 1_000 })
    .run();
}

function uncheckpointM0009(): void {
  getGatewayDb().delete(oneTimeMigrations).run();
}

function seedGatewayContact(id: string): void {
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `gw-${id}`,
      role: "contact",
      principalId: null,
      createdAt: 500,
      updatedAt: 500,
    })
    .run();
}

function seedGatewayInvite(
  opts: Partial<typeof ingressInvites.$inferInsert> & { id: string },
): void {
  getGatewayDb()
    .insert(ingressInvites)
    .values({
      sourceChannel: "telegram",
      inviteCodeHash: "gw-code-hash",
      contactId: "c1",
      note: null,
      maxUses: 1,
      useCount: 0,
      expiresAt: 9_999_999,
      status: "active",
      createdAt: 100,
      updatedAt: 200,
      ...opts,
    })
    .run();
}

function gatewayInviteIds(): string[] {
  const rows = getGatewayDb()
    .$client.prepare("SELECT id FROM ingress_invites")
    .all() as { id: string }[];
  return rows.map((r) => r.id).sort();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0010-drop-assistant-ingress-invites", () => {
  test("skips entirely (no purge, no drop) when m0009 is not checkpointed", async () => {
    uncheckpointM0009();
    seedGatewayContact("c1");
    seedGatewayInvite({ id: "a2a-1", sourceChannel: "a2a" });
    seedGatewayInvite({ id: "tg-1", sourceChannel: "telegram" });

    const result = await m0010Up();

    expect(result).toBe("skip");
    // The backfill source table and the a2a rows are untouched.
    expect(fakeAssistantDb.hasInvitesTable).toBe(true);
    expect(fakeAssistantDb.dropCalls).toBe(0);
    expect(gatewayInviteIds()).toEqual(["a2a-1", "tg-1"]);

    // Once the checkpoint lands, the same boot-retry path completes.
    checkpointM0009();
    expect(await m0010Up()).toBe("done");
    expect(fakeAssistantDb.hasInvitesTable).toBe(false);
    expect(gatewayInviteIds()).toEqual(["tg-1"]);
  });

  test("purges phantom a2a rows and drops the assistant table", async () => {
    seedGatewayContact("c1");
    seedGatewayInvite({ id: "a2a-1", sourceChannel: "a2a" });
    seedGatewayInvite({ id: "a2a-2", sourceChannel: "a2a" });
    seedGatewayInvite({ id: "tg-1", sourceChannel: "telegram" });
    seedGatewayInvite({ id: "voice-1", sourceChannel: "phone" });

    const result = await m0010Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual(["tg-1", "voice-1"]);
    expect(fakeAssistantDb.hasInvitesTable).toBe(false);
  });

  test("purges a2a rows even when the assistant table is already gone", async () => {
    fakeAssistantDb.hasInvitesTable = false;
    seedGatewayContact("c1");
    seedGatewayInvite({ id: "a2a-1", sourceChannel: "a2a" });

    const result = await m0010Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual([]);
  });

  test("returns skip on IPC failure (retry next boot), a2a purge still applied", async () => {
    fakeAssistantDb.failDrop = true;
    seedGatewayContact("c1");
    seedGatewayInvite({ id: "a2a-1", sourceChannel: "a2a" });
    seedGatewayInvite({ id: "tg-1", sourceChannel: "telegram" });

    const result = await m0010Up();

    expect(result).toBe("skip");
    expect(gatewayInviteIds()).toEqual(["tg-1"]);
    expect(fakeAssistantDb.hasInvitesTable).toBe(true);

    // Retry after the IPC path recovers completes the drop.
    fakeAssistantDb.failDrop = false;
    expect(await m0010Up()).toBe("done");
    expect(fakeAssistantDb.hasInvitesTable).toBe(false);
  });

  test("idempotent: running twice yields the same state", async () => {
    seedGatewayContact("c1");
    seedGatewayInvite({ id: "a2a-1", sourceChannel: "a2a" });
    seedGatewayInvite({ id: "tg-1", sourceChannel: "telegram" });

    expect(await m0010Up()).toBe("done");
    const firstRunIds = gatewayInviteIds();
    expect(await m0010Up()).toBe("done");

    expect(gatewayInviteIds()).toEqual(firstRunIds);
    expect(fakeAssistantDb.hasInvitesTable).toBe(false);
  });

  test("is registered after m0009 and gates on m0009's registered checkpoint key", () => {
    const keys = MIGRATIONS.map((m) => m.key);
    const backfillIndex = keys.indexOf(M0009_CHECKPOINT_KEY);
    const dropIndex = keys.indexOf("m0010-drop-assistant-ingress-invites");

    expect(backfillIndex).toBeGreaterThanOrEqual(0);
    expect(dropIndex).toBeGreaterThan(backfillIndex);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0010Down()).toBe("done");
  });
});

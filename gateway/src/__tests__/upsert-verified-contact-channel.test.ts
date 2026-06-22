/**
 * Tests for upsertVerifiedContactChannel: must not reactivate
 * revoked or blocked channels.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./test-preload.js";

// ---------------------------------------------------------------------------
// DB mock — configurable per test
// ---------------------------------------------------------------------------

type ExistingRow = {
  channelId: string;
  contactId: string;
  channelStatus: string;
};

let queryRows: ExistingRow[] = [];
const queryCalls: { sql: string; params: unknown[] }[] = [];
const runCalls: { sql: string; params: unknown[] }[] = [];

// Fake gateway DB: records update/insert calls and returns a configurable
// `changes` count per update so the resilient dual-write fallback can be
// exercised (id-keyed update → logical-key update → insert-mirror).
type GwUpdate = { set: Record<string, unknown>; where: unknown };
type GwInsert = { table: unknown; values: Record<string, unknown> };
const gwUpdates: GwUpdate[] = [];
const gwInserts: GwInsert[] = [];
// Successive row-counts returned by `.update(...).returning().all()`, FIFO.
// A non-zero count means the update matched an existing gateway row.
let gwUpdateChanges: number[] = [];
// Status returned by the authoritative gateway pre-check (`.select(...).get()`).
// null models a missing gateway row (legacy/unmirrored happy path).
let gwSelectStatus: string | null = null;
// Whether the insert-mirror reports a written row (`.returning().all()`).
// false models a (type,address) conflict with a blocked/revoked row.
let gwInsertWrote = true;

mock.module("../db/connection.js", () => ({
  getGatewayDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () =>
            gwSelectStatus === null ? undefined : { status: gwSelectStatus },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          returning: () => ({
            all: () => {
              void table;
              gwUpdates.push({ set, where });
              const n = gwUpdateChanges.shift() ?? 0;
              return Array.from({ length: n }, () => ({ id: "x" }));
            },
          }),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          run: () => {
            gwInserts.push({ table, values });
          },
          returning: () => ({
            all: () => {
              gwInserts.push({ table, values });
              return gwInsertWrote ? [{ id: "x" }] : [];
            },
          }),
        }),
      }),
    }),
  }),
}));

const TEST_SOCKET_PATH = join(
  tmpdir(),
  `vellum-upsert-contact-channel-test-${process.pid}.sock`,
);

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: async (sql: string, params: unknown[]) => {
    queryCalls.push({ sql, params });
    return queryRows;
  },
  assistantDbRun: async (sql: string, params: unknown[]) => {
    runCalls.push({ sql, params });
  },
}));

mock.module("../db/schema.js", () => ({
  contactChannels: {
    id: "id",
    type: "type",
    address: "address",
    status: "status",
  },
  contacts: "contacts",
}));

mock.module("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    op: "sql",
    strings: Array.from(strings),
    vals,
  }),
}));

mock.module("../verification/identity.js", () => ({
  canonicalizeInboundIdentity: (_channel: string, id: string) => id,
}));

mock.module("../ipc/socket-path.js", () => ({
  resolveIpcSocketPath: () => ({ path: TEST_SOCKET_PATH }),
}));

// Import after mocks
const { upsertContactChannel, upsertVerifiedContactChannel } =
  await import("../verification/contact-helpers.js");

beforeEach(() => {
  queryRows = [];
  queryCalls.length = 0;
  runCalls.length = 0;
  gwUpdates.length = 0;
  gwInserts.length = 0;
  // Default: the id-keyed gateway update lands on an existing row.
  gwUpdateChanges = [1];
  // Default: no authoritative gateway row (legacy/unmirrored happy path).
  gwSelectStatus = null;
  gwInsertWrote = true;
  writeFileSync(TEST_SOCKET_PATH, "");
});

afterEach(() => {
  rmSync(TEST_SOCKET_PATH, { force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upsertVerifiedContactChannel — revoked/blocked guards", () => {
  test("skips update when existing channel is revoked", async () => {
    queryRows = [
      {
        channelId: "ch-1",
        contactId: "co-1",
        channelStatus: "revoked",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("skips update when channel is blocked", async () => {
    queryRows = [
      {
        channelId: "ch-2",
        contactId: "co-2",
        channelStatus: "blocked",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("skips update when a guardian's channel is revoked", async () => {
    queryRows = [
      {
        channelId: "ch-3",
        contactId: "co-3",
        channelStatus: "revoked",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("updates an active channel belonging to a guardian contact", async () => {
    queryRows = [
      {
        channelId: "ch-4",
        contactId: "co-4",
        channelStatus: "active",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(1);
  });

  test("updates an active channel belonging to a non-guardian contact", async () => {
    queryRows = [
      {
        channelId: "ch-5",
        contactId: "co-5",
        channelStatus: "active",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(1);
  });

  test("creates new contact + channel when no existing channel found", async () => {
    queryRows = [];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    const inserts = runCalls.filter((c) => c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(2);
  });

  test("update path stamps verified_at + verified_via='challenge'", async () => {
    queryRows = [
      { channelId: "ch-6", contactId: "co-6", channelStatus: "active" },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    const update = runCalls.find((c) =>
      c.sql.includes("UPDATE contact_channels"),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain("status = 'active'");
    expect(update!.sql).toContain("verified_at = ?");
    expect(update!.sql).toContain("verified_via = ?");
    expect(update!.params).toContain("challenge");
    // verified_at uses a numeric timestamp
    expect(update!.params.some((p) => typeof p === "number")).toBe(true);
  });

  test("insert path stamps verified_at + verified_via='challenge'", async () => {
    queryRows = [];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    const channelInsert = runCalls.find((c) =>
      c.sql.includes("INSERT OR IGNORE INTO contact_channels"),
    );
    expect(channelInsert).toBeTruthy();
    expect(channelInsert!.sql).toContain("'active'");
    expect(channelInsert!.sql).toContain("verified_at");
    expect(channelInsert!.sql).toContain("verified_via");
    expect(channelInsert!.params).toContain("challenge");
  });

  test("resolves the gateway row by (type,address) when the id-keyed update misses", async () => {
    queryRows = [
      { channelId: "assistant-ch", contactId: "co-8", channelStatus: "active" },
    ];
    // id-keyed update misses (0 changes); logical-key update lands (1).
    gwUpdateChanges = [0, 1];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550002222",
      externalChatId: "+15550002222",
    });

    expect(gwUpdates).toHaveLength(2);
    // Second update is keyed on the logical (type,address) key, not the id.
    expect(gwUpdates[1]!.where).toMatchObject({ op: "and" });
    expect(gwUpdates[1]!.set).toMatchObject({
      status: "active",
      verifiedVia: "challenge",
    });
    expect(gwUpdates[1]!.set.verifiedAt).toEqual(expect.any(Number));
    // No insert-mirror needed — the logical-key update succeeded.
    expect(gwInserts).toHaveLength(0);
  });

  test("inserts a verified gateway channel when no gateway row exists at all", async () => {
    queryRows = [
      { channelId: "assistant-ch", contactId: "co-9", channelStatus: "active" },
    ];
    // Both id-keyed and logical-key updates miss → insert-mirror.
    gwUpdateChanges = [0, 0];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550003333",
      externalChatId: "+15550003333",
    });

    expect(gwUpdates).toHaveLength(2);
    const channelInsert = gwInserts.find(
      (i) => i.values.type === "phone" && i.values.address === "+15550003333",
    );
    expect(channelInsert).toBeTruthy();
    expect(channelInsert!.values).toMatchObject({
      contactId: "co-9",
      status: "active",
      verifiedVia: "challenge",
    });
    expect(channelInsert!.values.verifiedAt).toEqual(expect.any(Number));
    // Parent contact mirrored too.
    expect(gwInserts.some((i) => i.values.id === "co-9")).toBe(true);
  });

  test("guards both gateway update paths against blocked/revoked rows", async () => {
    // Stale assistant mirror is active, so the caller's guard passes and we
    // reach the gateway write; the authoritative gateway row may be
    // blocked/revoked and must not be reactivated.
    queryRows = [
      { channelId: "assistant-ch", contactId: "co-10", channelStatus: "active" },
    ];
    gwUpdateChanges = [0, 0];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550004444",
      externalChatId: "+15550004444",
    });

    const hasBlockedRevokedGuard = (whereRaw: unknown) => {
      const where = whereRaw as { op?: string; conds?: unknown[] };
      return (
        where.op === "and" &&
        (where.conds ?? []).some(
          (c) =>
            typeof c === "object" &&
            c !== null &&
            (c as { op?: string }).op === "sql" &&
            ((c as { strings?: string[] }).strings ?? [])
              .join("")
              .includes("not in ('blocked', 'revoked')"),
        )
      );
    };

    expect(gwUpdates).toHaveLength(2);
    // Both the id-keyed and logical-key updates carry the guard, so a
    // blocked/revoked gateway row is excluded from reactivation.
    expect(hasBlockedRevokedGuard(gwUpdates[0]!.where)).toBe(true);
    expect(hasBlockedRevokedGuard(gwUpdates[1]!.where)).toBe(true);
  });

  test("returns verified:false and skips assistant UPDATE when gateway row is blocked", async () => {
    // Assistant mirror is active/claimable, but the authoritative gateway row
    // is blocked: verification must be rejected without activating the mirror.
    queryRows = [
      { channelId: "ch-b", contactId: "co-b", channelStatus: "active" },
    ];
    gwSelectStatus = "blocked";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550005555",
      externalChatId: "+15550005555",
    });

    expect(result).toEqual({ verified: false });
    expect(
      runCalls.filter(
        (c) => c.sql.includes("UPDATE") && c.sql.includes("status = 'active'"),
      ),
    ).toHaveLength(0);
    // Gateway write never attempted (returned before the dual-write).
    expect(gwUpdates).toHaveLength(0);
    expect(gwInserts).toHaveLength(0);
  });

  test("returns verified:false and skips assistant UPDATE when gateway row is revoked", async () => {
    queryRows = [
      { channelId: "ch-r", contactId: "co-r", channelStatus: "active" },
    ];
    gwSelectStatus = "revoked";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550006666",
      externalChatId: "+15550006666",
    });

    expect(result).toEqual({ verified: false });
    expect(
      runCalls.filter(
        (c) => c.sql.includes("UPDATE") && c.sql.includes("status = 'active'"),
      ),
    ).toHaveLength(0);
    expect(gwUpdates).toHaveLength(0);
    expect(gwInserts).toHaveLength(0);
  });

  test("returns verified:true when no authoritative gateway row exists", async () => {
    queryRows = [
      { channelId: "ch-ok", contactId: "co-ok", channelStatus: "active" },
    ];
    gwSelectStatus = null;

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550007777",
      externalChatId: "+15550007777",
    });

    expect(result).toEqual({ verified: true });
    expect(
      runCalls.filter((c) => c.sql.includes("UPDATE contact_channels")),
    ).toHaveLength(1);
  });

  test("returns verified:false when the insert-mirror is no-op'd by a blocked/revoked row", async () => {
    // Pre-check sees no row (race), updates both miss, and the insert-mirror
    // conflicts with a blocked/revoked row landed concurrently.
    queryRows = [
      { channelId: "ch-race", contactId: "co-race", channelStatus: "active" },
    ];
    gwSelectStatus = null;
    gwUpdateChanges = [0, 0];
    gwInsertWrote = false;

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550008888",
      externalChatId: "+15550008888",
    });

    expect(result).toEqual({ verified: false });
  });

  test("honors an explicit verifiedVia value on the update path", async () => {
    queryRows = [
      { channelId: "ch-7", contactId: "co-7", channelStatus: "active" },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
      verifiedVia: "manual",
    });

    const update = runCalls.find((c) =>
      c.sql.includes("UPDATE contact_channels"),
    );
    expect(update!.params).toContain("manual");
  });
});

describe("upsertContactChannel — channel address casing", () => {
  test("preserves original Slack address casing", async () => {
    queryRows = [];

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U123EXAMPLE",
      externalChatId: "D123EXAMPLE",
    });

    const channelInsert = runCalls.find((c) =>
      c.sql.includes("INSERT OR IGNORE INTO contact_channels"),
    );
    expect(channelInsert).toBeTruthy();
    // address preserves original casing
    expect(channelInsert!.params[3]).toBe("U123EXAMPLE");

    expect(queryCalls[0]!.sql).toContain("cc.address = ? COLLATE NOCASE");
    expect(queryCalls[0]!.params).toEqual(["slack", "U123EXAMPLE"]);
  });
});

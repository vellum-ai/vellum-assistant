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

// Assistant-mirror rows served by the typed identity lookup; the daemon
// handler returns the most-recently-updated match, modeled here as rows[0].
let queryRows: ExistingRow[] = [];
// Typed identity-lookup selectors, recorded per test.
const lookupCalls: { type?: string; address?: string; channelId?: string }[] =
  [];
// When true, lookupContactChannelIdentity throws (unreachable daemon).
let lookupThrow = false;
// Typed identity-mirror IPC calls (contacts_mirror_*), recorded per test.
const mirrorCalls: { method: string; body: Record<string, unknown> }[] = [];
// When true, ipcCallAssistant throws for any mirror method (models an
// unreachable/failing daemon mirror).
let mirrorThrow = false;

const mirrorUpserts = () =>
  mirrorCalls.filter((c) => c.method === "contacts_mirror_upsert_channel");

// ACL fields the identity mirror must never carry (gateway-owned).
const ACL_MIRROR_FIELDS = [
  "status",
  "policy",
  "verifiedAt",
  "verifiedVia",
  "revokedReason",
  "blockedReason",
  "role",
  "principalId",
] as const;
const expectIdentityOnly = (body: Record<string, unknown>): void => {
  for (const field of ACL_MIRROR_FIELDS) {
    expect(body[field]).toBeUndefined();
  }
};

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
// When true, the authoritative gateway channel write throws (infra failure):
// the verified-set update lands a throw so the fail-closed path is exercised.
let gwWriteThrows = false;

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
              if (gwWriteThrows) throw new Error("gateway write failed");
              gwUpdates.push({ set, where });
              const n = gwUpdateChanges.shift() ?? 0;
              return Array.from({ length: n }, () => ({ id: "x" }));
            },
          }),
          // reassignChannelContact re-parents a channel via a bare update.
          run: () => {
            void table;
            gwUpdates.push({ set, where });
          },
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
              if (gwWriteThrows) throw new Error("gateway write failed");
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

mock.module("../ipc/contacts-info-client.js", () => ({
  lookupContactChannelIdentity: async (selector: {
    type?: string;
    address?: string;
    channelId?: string;
  }) => {
    lookupCalls.push(selector);
    if (lookupThrow) throw new Error("identity lookup IPC failed");
    const row = queryRows[0];
    if (!row) return null;
    return {
      id: row.channelId,
      contactId: row.contactId,
      type: selector.type ?? "phone",
      address: selector.address ?? "",
      externalChatId: null,
      displayName: null,
    };
  },
  // Not exercised here (deleteContactIfOrphaned only).
  probeContactMirror: async () => {
    throw new Error("probeContactMirror not stubbed for this suite");
  },
}));

mock.module("../ipc/assistant-client.js", () => ({
  IpcHandlerError: class extends Error {},
  IpcTransportError: class extends Error {},
  ipcCallAssistant: async (
    method: string,
    params?: { body?: Record<string, unknown> },
  ) => {
    mirrorCalls.push({ method, body: params?.body ?? {} });
    if (mirrorThrow) {
      throw new Error(`ipcCallAssistant mirror failed: ${method}`);
    }
    return { ok: true };
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
  lookupCalls.length = 0;
  lookupThrow = false;
  mirrorCalls.length = 0;
  mirrorThrow = false;
  gwUpdates.length = 0;
  gwInserts.length = 0;
  // Default: the id-keyed gateway update lands on an existing row.
  gwUpdateChanges = [1];
  // Default: no authoritative gateway row (legacy/unmirrored happy path).
  gwSelectStatus = null;
  gwInsertWrote = true;
  gwWriteThrows = false;
  writeFileSync(TEST_SOCKET_PATH, "");
});

afterEach(() => {
  rmSync(TEST_SOCKET_PATH, { force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upsertVerifiedContactChannel — revoked/blocked guards", () => {
  test("skips update when the authoritative gateway channel is revoked", async () => {
    // The mirror is stale-active; the gateway row (source of truth) is revoked.
    queryRows = [
      {
        channelId: "ch-1",
        contactId: "co-1",
        channelStatus: "active",
      },
    ];
    gwSelectStatus = "revoked";

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(mirrorUpserts()).toHaveLength(0);
  });

  test("skips update when the authoritative gateway channel is blocked", async () => {
    queryRows = [
      {
        channelId: "ch-2",
        contactId: "co-2",
        channelStatus: "active",
      },
    ];
    gwSelectStatus = "blocked";

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(mirrorUpserts()).toHaveLength(0);
  });

  test("proceeds when only the assistant mirror is revoked but the gateway row is active", async () => {
    // A gateway reactivation can leave a stale revoked mirror. The verification
    // decision follows the gateway (active here), so the activation proceeds.
    queryRows = [
      {
        channelId: "ch-3",
        contactId: "co-3",
        channelStatus: "revoked",
      },
    ];
    gwSelectStatus = "active";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(result).toEqual({ verified: true });
    expect(mirrorUpserts()).toHaveLength(1);
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

    expect(mirrorUpserts()).toHaveLength(1);
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

    expect(mirrorUpserts()).toHaveLength(1);
  });

  test("creates new contact + channel when no existing channel found", async () => {
    queryRows = [];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    // The create path fires a single identity-mirror upsert (contact + channel).
    expect(mirrorUpserts()).toHaveLength(1);
  });

  test("Finding B: the create path shares the channel id between gateway and mirror", async () => {
    queryRows = [];
    // Force the insert-mirror so the gateway channel row is created here and its
    // id is observable.
    gwUpdateChanges = [0, 0];
    gwSelectStatus = null;

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550003399",
      externalChatId: "+15550003399",
    });

    const mirror = mirrorUpserts()[0];
    const gwChannel = gwInserts.find(
      (i) => i.values.type === "phone" && i.values.address === "+15550003399",
    );
    expect(mirror).toBeTruthy();
    expect(gwChannel).toBeTruthy();
    // The mirror channel id equals the gateway channel id: both stores key the
    // channel identically.
    expect(mirror!.body.channelId).toBe(gwChannel!.values.id);
  });

  test("new-insert path returns verified:false and writes nothing when gateway row is blocked", async () => {
    // No existing assistant channel, but the authoritative gateway DB already
    // has a blocked row for the same (type,address): no new active channel.
    queryRows = [];
    gwSelectStatus = "blocked";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    expect(result).toEqual({ verified: false });
    expect(mirrorUpserts()).toHaveLength(0);
    expect(gwInserts).toHaveLength(0);
    expect(gwUpdates).toHaveLength(0);
  });

  test("new-insert path returns verified:false and writes nothing when gateway row is revoked", async () => {
    queryRows = [];
    gwSelectStatus = "revoked";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    expect(result).toEqual({ verified: false });
    expect(mirrorUpserts()).toHaveLength(0);
    expect(gwInserts).toHaveLength(0);
    expect(gwUpdates).toHaveLength(0);
  });

  test("new-insert path updates an existing non-blocked gateway row by logical key", async () => {
    // Assistant lookup misses, but the gateway already has a NON-blocked
    // (unverified) row for the same (type,address) — e.g. a gateway-created,
    // unmirrored contact. The id-keyed update misses (different UUID); the
    // logical-key update lands. The channel must end up active/verified, not a
    // silent no-op, and the path returns verified:true.
    queryRows = [];
    gwSelectStatus = null;
    gwUpdateChanges = [0, 1];

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001212",
      externalChatId: "+15550001212",
    });

    expect(result).toEqual({ verified: true });
    // id-keyed update missed, logical-key update landed — no insert-mirror.
    expect(gwUpdates).toHaveLength(2);
    expect(gwUpdates[1]!.set).toMatchObject({
      status: "active",
      policy: "allow",
      verifiedVia: "challenge",
    });
    // No channel insert-mirror: the existing row was updated in place.
    expect(
      gwInserts.some(
        (i) => i.values.type === "phone" && i.values.address === "+15550001212",
      ),
    ).toBe(false);
  });

  test("new-insert path returns verified:true when no gateway row exists", async () => {
    queryRows = [];
    gwSelectStatus = null;

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    expect(result).toEqual({ verified: true });
    expect(mirrorUpserts()).toHaveLength(1);
  });

  test("update path stamps verified state on the gateway, not the assistant mirror", async () => {
    queryRows = [
      { channelId: "ch-6", contactId: "co-6", channelStatus: "active" },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    // Gateway DB owns the verified ACL state.
    const gwActivate = gwUpdates.find(
      (u) => (u.set as { status?: string }).status === "active",
    );
    expect(gwActivate).toBeTruthy();
    expect(gwActivate!.set).toMatchObject({ verifiedVia: "challenge" });
    expect(gwActivate!.set.verifiedAt).toEqual(expect.any(Number));

    // The identity-mirror upsert carries identity/info only — no ACL fields.
    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expectIdentityOnly(upsert!.body);
  });

  test("insert path stamps verified state on the gateway, not the assistant mirror", async () => {
    queryRows = [];
    // Force the insert-mirror path so the gateway channel row is created here.
    gwUpdateChanges = [0, 0];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    // Gateway DB owns the verified ACL state.
    const gwChannelInsert = gwInserts.find(
      (i) => i.values.type === "phone" && i.values.status === "active",
    );
    expect(gwChannelInsert).toBeTruthy();
    expect(gwChannelInsert!.values).toMatchObject({ verifiedVia: "challenge" });

    // The identity-mirror upsert carries identity/info only — no ACL fields.
    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expectIdentityOnly(upsert!.body);
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
      {
        channelId: "assistant-ch",
        contactId: "co-10",
        channelStatus: "active",
      },
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
    expect(mirrorUpserts()).toHaveLength(0);
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
    expect(mirrorUpserts()).toHaveLength(0);
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
    expect(mirrorUpserts()).toHaveLength(1);
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

  test("gateway-first: skips assistant activation when the gateway write is rejected after the pre-check", async () => {
    // An existing assistant channel + a gateway pre-check that passes, but the
    // guarded gateway write is rejected (row became blocked/revoked in the
    // race). The assistant mirror must NOT be activated, so a blocked actor is
    // never left active locally.
    queryRows = [
      {
        channelId: "ch-race",
        contactId: "co-race",
        channelStatus: "unverified",
      },
    ];
    gwSelectStatus = "unverified"; // pre-check passes
    gwUpdateChanges = [0, 0]; // guarded gateway updates miss
    gwInsertWrote = false; // insert-mirror no-op → write rejected

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    expect(result).toEqual({ verified: false });
    expect(mirrorUpserts()).toHaveLength(0);
  });

  test("fails closed (verified:false) when the gateway write throws on the existing-channel path", async () => {
    // The pre-check passes, but the authoritative gateway write throws (infra
    // failure). The mirror no longer records ACL state, so falling through to
    // verified:true would reply success with no DB recording an active channel.
    queryRows = [
      { channelId: "ch-throw", contactId: "co-throw", channelStatus: "active" },
    ];
    gwSelectStatus = "active";
    gwWriteThrows = true;

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550002020",
      externalChatId: "+15550002020",
    });

    expect(result).toEqual({ verified: false });
    // The assistant mirror activation must NOT fire on a lost gateway write.
    expect(mirrorUpserts()).toHaveLength(0);
  });

  test("fails closed (verified:false) when the gateway write throws on the new-insert path", async () => {
    queryRows = [];
    gwSelectStatus = null;
    gwWriteThrows = true;

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550002121",
      externalChatId: "+15550002121",
    });

    expect(result).toEqual({ verified: false });
    // No assistant mirror INSERT for an actor whose gateway write was lost.
    expect(mirrorUpserts()).toHaveLength(0);
  });

  test("allowRevokedReactivation: a revoked authoritative gateway row is reactivated and the activation update fires", async () => {
    // Stale assistant mirror is active so we reach the existing-channel branch;
    // the authoritative gateway row is revoked. With the flag, the invite path
    // reactivates it and the assistant activation UPDATE fires (status→active).
    queryRows = [
      { channelId: "ch-rev", contactId: "co-rev", channelStatus: "active" },
    ];
    gwSelectStatus = "revoked";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001313",
      externalChatId: "+15550001313",
      verifiedVia: "invite",
      allowRevokedReactivation: true,
    });

    expect(result).toEqual({ verified: true });
    expect(mirrorUpserts()).toHaveLength(1);
    // The gateway reactivation guard excludes only 'blocked', allowing the
    // revoked row to be UPDATED to active.
    expect(gwUpdates[0]!.where).toMatchObject({ op: "and" });
  });

  test("allowRevokedReactivation: a blocked gateway row is still refused", async () => {
    queryRows = [
      { channelId: "ch-blk", contactId: "co-blk", channelStatus: "active" },
    ];
    gwSelectStatus = "blocked";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001414",
      externalChatId: "+15550001414",
      verifiedVia: "invite",
      allowRevokedReactivation: true,
    });

    expect(result).toEqual({ verified: false });
    expect(mirrorUpserts()).toHaveLength(0);
    expect(gwUpdates).toHaveLength(0);
    expect(gwInserts).toHaveLength(0);
  });

  test("reactivation: a gateway-revoked channel is reactivated with the flag and later verification succeeds", async () => {
    // The gateway row is revoked. With the flag the invite path reactivates it
    // (the gateway write lands), the activation UPDATE fires, and the result is
    // verified:true even though the assistant mirror is itself stale-revoked.
    queryRows = [
      { channelId: "ch-rev", contactId: "co-rev", channelStatus: "revoked" },
    ];
    gwSelectStatus = "revoked";

    const reactivate = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001515",
      externalChatId: "+15550001515",
      verifiedVia: "invite",
      allowRevokedReactivation: true,
    });

    expect(reactivate).toEqual({ verified: true });
    const activate = mirrorUpserts()[0];
    expect(activate).toBeTruthy();
    expect(activate!.body.address).toBe("+15550001515");

    // A later plain verification (no flag) against the now-active gateway row
    // must succeed: the decision follows the gateway, not the stale mirror.
    mirrorCalls.length = 0;
    gwUpdates.length = 0;
    gwSelectStatus = "active";

    const reverify = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001515",
      externalChatId: "+15550001515",
    });

    expect(reverify).toEqual({ verified: true });
  });

  test("without the flag a gateway-revoked channel is still refused", async () => {
    queryRows = [
      {
        channelId: "ch-mirror",
        contactId: "co-mirror",
        channelStatus: "active",
      },
    ];
    gwSelectStatus = "revoked";

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001616",
      externalChatId: "+15550001616",
      verifiedVia: "invite",
    });

    expect(result).toEqual({ verified: false });
    expect(mirrorUpserts()).toHaveLength(0);
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

    // verifiedVia is gateway-owned; the assistant mirror no longer carries it.
    const gwActivate = gwUpdates.find(
      (u) => (u.set as { status?: string }).status === "active",
    );
    expect(gwActivate!.set).toMatchObject({ verifiedVia: "manual" });
  });
});

describe("upsertVerifiedContactChannel — invite target-contact binding", () => {
  test("reassigns an existing channel to the supplied target contact", async () => {
    // The redeemer's channel currently lives under a different contact (the
    // guardian); the invite binds it to the target contact "mom".
    queryRows = [
      {
        channelId: "ch-redeemer",
        contactId: "co-guardian",
        channelStatus: "active",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "redeemer-tg",
      externalChatId: "redeemer-tg",
      verifiedVia: "invite",
      contactId: "co-mom",
    });

    // The identity-mirror upsert re-parents the (type,address) channel to the
    // target contact.
    const reparent = mirrorUpserts()[0];
    expect(reparent).toBeTruthy();
    expect(reparent!.body).toMatchObject({
      contactId: "co-mom",
      type: "telegram",
      address: "redeemer-tg",
      // Genuine target-contact bind: the gateway reparented, so the mirror must
      // reparent too.
      reassignConflictingChannels: true,
    });

    // Gateway channel re-parented to the target contact too.
    const gwReparent = gwUpdates.find(
      (u) => (u.set as { contactId?: string }).contactId === "co-mom",
    );
    expect(gwReparent).toBeTruthy();

    // The re-parent keys on the (type,address) logical key, not the assistant
    // channel id: the gateway row can live under a different UUID (m0006
    // reconcile), where an id-only update would re-parent nothing.
    const where = gwReparent!.where as {
      op: string;
      conds: { op: string; col?: unknown; val?: unknown }[];
    };
    expect(where.op).toBe("and");
    expect(where.conds).toContainEqual({
      op: "eq",
      col: "type",
      val: "telegram",
    });
    expect(where.conds.some((c) => c.op === "eq" && c.col === "id")).toBe(
      false,
    );

    // The verified gateway write lands under the bound (target) contact.
    expect(
      gwUpdates.some((u) => (u.set as { status?: string }).status === "active"),
    ).toBe(true);
  });

  test("activates the gateway channel even when the assistant mirror upsert fails", async () => {
    queryRows = [
      {
        channelId: "ch-redeemer",
        contactId: "co-guardian",
        channelStatus: "active",
      },
    ];
    // The assistant-DB mirror upsert throws transiently. Invite redemption runs
    // this soft, so the failure is swallowed and the gateway result stands.
    mirrorThrow = true;

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "redeemer-tg",
      externalChatId: "redeemer-tg",
      verifiedVia: "invite",
      contactId: "co-mom",
      softMirrorFailures: true,
    });

    // The gateway activation still ran (mirror failure is best-effort), so the
    // gateway source of truth is verified rather than left inactive.
    expect(result).toEqual({ verified: true });
    expect(
      gwUpdates.some((u) => (u.set as { status?: string }).status === "active"),
    ).toBe(true);
  });

  test("does not reassign when the channel already belongs to the target contact", async () => {
    queryRows = [
      { channelId: "ch-x", contactId: "co-mom", channelStatus: "active" },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "redeemer-tg",
      externalChatId: "redeemer-tg",
      verifiedVia: "invite",
      contactId: "co-mom",
    });

    // No gateway re-parent (a bare contactId update) fires when the channel
    // already belongs to the target contact.
    const gwReparent = gwUpdates.find(
      (u) =>
        (u.set as { contactId?: string }).contactId === "co-mom" &&
        (u.set as { status?: string }).status === undefined,
    );
    expect(gwReparent).toBeUndefined();

    // The gateway did NOT reparent, so the mirror upsert must not either.
    const upsert = mirrorUpserts()[0];
    expect(upsert!.body.reassignConflictingChannels).toBe(false);
  });

  test("creates a fresh channel under the supplied target contact", async () => {
    queryRows = [];
    gwSelectStatus = null;

    await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "fresh-tg",
      externalChatId: "fresh-tg",
      verifiedVia: "invite",
      contactId: "co-target",
    });

    // The identity-mirror upsert uses the supplied target contactId, not a
    // freshly minted UUID.
    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expect(upsert!.body.contactId).toBe("co-target");
    // A target contact drove reassignChannelContact on the gateway, so the
    // mirror reparents a raced conflicting channel to match.
    expect(upsert!.body.reassignConflictingChannels).toBe(true);
  });

  test("re-parents a divergent gateway row to the target when the assistant lookup misses", async () => {
    // The assistant mirror has no row (no-existing branch), but the gateway
    // already holds the (type,address) row under a different contact.
    queryRows = [];
    gwSelectStatus = "unverified"; // non-blocked gateway row → pre-check passes

    await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "diverged-tg",
      externalChatId: "diverged-tg",
      verifiedVia: "invite",
      contactId: "co-target",
    });

    // The gateway row is re-parented to the target by the (type,address)
    // logical key, not the assistant channel id (the byKey activation update
    // omits contactId, so without this the gateway row keeps the old contact).
    const gwReparent = gwUpdates.find(
      (u) => (u.set as { contactId?: string }).contactId === "co-target",
    );
    expect(gwReparent).toBeTruthy();
    const where = gwReparent!.where as {
      op: string;
      conds: { op: string; col?: unknown; val?: unknown }[];
    };
    expect(where.op).toBe("and");
    expect(where.conds).toContainEqual({
      op: "eq",
      col: "type",
      val: "telegram",
    });
    expect(where.conds.some((c) => c.op === "eq" && c.col === "id")).toBe(
      false,
    );
  });
});

// The mirror's reassignConflictingChannels must track the gateway's ACTUAL
// reparent decision in each branch — not the call path — or the two stores end
// up disagreeing about which contact owns a channel.
describe("upsertVerifiedContactChannel — mirror reparent tracks gateway reparent", () => {
  test("plain verification, no target, no existing channel: mirror does NOT reparent (Codex race)", async () => {
    // Create branch, no targetContactId. The gateway does NOT call
    // reassignChannelContact; a raced inbound seed under a different contact is
    // left in place by writeVerifiedGatewayChannel (its update set omits
    // contactId). The mirror must NOT reparent, or it would move the channel to
    // this fresh contactId while the gateway keeps the seed contact.
    queryRows = [];
    gwSelectStatus = null;

    await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "plain-create-tg",
      externalChatId: "plain-create-tg",
    });

    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expect(upsert!.body.reassignConflictingChannels).toBe(false);
  });

  test("plain verification, no target, existing channel: mirror does NOT reparent", async () => {
    // Update branch, no target-contact bind → boundContactId === row.contactId,
    // so the gateway does not reparent and neither must the mirror.
    queryRows = [
      { channelId: "ch-plain", contactId: "co-plain", channelStatus: "active" },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "plain-update-tg",
      externalChatId: "plain-update-tg",
    });

    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expect(upsert!.body.contactId).toBe("co-plain");
    expect(upsert!.body.reassignConflictingChannels).toBe(false);
  });
});

describe("identity lookup failure posture", () => {
  test("soft mode: a thrown identity lookup proceeds gateway-only via the create path", async () => {
    queryRows = [
      { channelId: "ch-hidden", contactId: "co-hidden", channelStatus: "active" },
    ];
    lookupThrow = true;
    gwSelectStatus = null;

    const result = await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550002323",
      externalChatId: "+15550002323",
      softMirrorFailures: true,
    });

    // The failed lookup is swallowed; the create path runs gateway-first (a
    // fresh parent contact is inserted) and the result reflects the gateway.
    expect(result).toEqual({ verified: true });
    expect(gwInserts.some((i) => i.values.role === "contact")).toBe(true);
    expect(mirrorUpserts()).toHaveLength(1);
  });

  test("hard mode (default): a thrown identity lookup propagates", async () => {
    lookupThrow = true;

    await expect(
      upsertVerifiedContactChannel({
        sourceChannel: "phone",
        externalUserId: "+15550002424",
        externalChatId: "+15550002424",
      }),
    ).rejects.toThrow("identity lookup IPC failed");
    // Nothing was written on either store.
    expect(mirrorUpserts()).toHaveLength(0);
    expect(gwUpdates).toHaveLength(0);
    expect(gwInserts).toHaveLength(0);
  });

  test("upsertContactChannel: a thrown identity lookup propagates (no soft mode)", async () => {
    lookupThrow = true;

    await expect(
      upsertContactChannel({
        sourceChannel: "slack",
        externalUserId: "ULOOKUPFAIL",
        externalChatId: "DLOOKUPFAIL",
      }),
    ).rejects.toThrow("identity lookup IPC failed");
    expect(mirrorUpserts()).toHaveLength(0);
    expect(gwInserts).toHaveLength(0);
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

    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    // address preserves original casing
    expect(upsert!.body.address).toBe("U123EXAMPLE");

    // The typed identity lookup receives the original casing; the daemon
    // handler owns the NOCASE match.
    expect(lookupCalls[0]).toEqual({ type: "slack", address: "U123EXAMPLE" });
  });
});

describe("upsertContactChannel — inbound seed identity mirror (id alignment + display refresh)", () => {
  test("Finding B: shares the gateway-minted channel id with the mirror on create", async () => {
    // First-seen actor: no existing mirror channel.
    queryRows = [];

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "USEED1",
      externalChatId: "DSEED1",
      displayName: "Seed One",
    });

    // The mirror create carries the SAME channel id the gateway inserted, so
    // both stores key the channel identically (id-keyed read-backs match).
    const mirror = mirrorUpserts()[0];
    expect(mirror).toBeTruthy();
    const gwChannel = gwInserts.find(
      (i) => i.values.type === "slack" && i.values.address === "USEED1",
    );
    expect(gwChannel).toBeTruthy();
    expect(mirror!.body.channelId).toBe(gwChannel!.values.id);
    // Inbound seed refreshes the mirror display name.
    expect(mirror!.body.refreshDisplayName).toBe(true);
    // Inbound seed never reparents (gateway insert uses onConflictDoNothing).
    expect(mirror!.body.reassignConflictingChannels).toBe(false);
  });

  test("Finding B: a follow-up seed update targets the aligned id and persists externalChatId", async () => {
    // The mirror row created by the first seed reads back with the SAME
    // (gateway-aligned) channel id.
    const alignedChannelId = "gw-aligned-ch";
    queryRows = [
      {
        channelId: alignedChannelId,
        contactId: "co-seed",
        channelStatus: "unverified",
      },
    ];

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "USEED1",
      externalChatId: "DSEED1-dm", // workspace seed → DM: new external chat id
      displayName: "Seed One",
    });

    // The gateway update keys on the aligned channel id (read back from the
    // mirror) and persists the new externalChatId. Before id-alignment the
    // mirror minted a divergent id, so this update matched 0 gateway rows.
    const gwUpdate = gwUpdates.find(
      (u) =>
        (u.set as { externalChatId?: string }).externalChatId === "DSEED1-dm",
    );
    expect(gwUpdate).toBeTruthy();
    expect(gwUpdate!.where).toMatchObject({
      op: "eq",
      col: "id",
      val: alignedChannelId,
    });
  });

  test("Finding C: seed refreshes the mirror name; invite binding preserves it", async () => {
    // Inbound seed (existing channel) → refresh flag set.
    queryRows = [
      { channelId: "ch-a", contactId: "co-a", channelStatus: "unverified" },
    ];
    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UREF",
      externalChatId: "DREF",
      displayName: "Renamed",
    });
    expect(mirrorUpserts()[0]!.body.refreshDisplayName).toBe(true);

    // Invite-binding (verified) path → NO refresh flag, so the primitive
    // preserves a guardian-curated contact name.
    mirrorCalls.length = 0;
    queryRows = [
      { channelId: "ch-b", contactId: "co-guardian", channelStatus: "active" },
    ];
    await upsertVerifiedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "redeemer",
      externalChatId: "redeemer",
      verifiedVia: "invite",
      contactId: "co-target",
    });
    expect(mirrorUpserts()[0]!.body.refreshDisplayName).toBeUndefined();
  });
});

describe("upsertContactChannel — bot sender classification", () => {
  test("creates a bot sender's contact as 'assistant' with a provenance note, not 'human'", async () => {
    queryRows = [];

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBOT99",
      externalChatId: "D123EXAMPLE",
      displayName: "Peer Assistant",
      contactType: "assistant",
      notes:
        "Automated Slack bot — messages from this contact are sent by an app, not a person.",
    });

    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expect(upsert!.body.displayName).toBe("Peer Assistant");
    expect(upsert!.body.notes).toContain("Automated Slack bot");
    expect(upsert!.body.contactType).toBe("assistant");
    expect(upsert!.body.contactType).not.toBe("human");
  });

  test("creates a human sender's contact as 'human' with no notes by default", async () => {
    queryRows = [];

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U123EXAMPLE",
      externalChatId: "D123EXAMPLE",
      displayName: "Alice",
    });

    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expect(upsert!.body.notes).toBeUndefined();
    expect(upsert!.body.contactType).toBe("human");
  });

  test("does not overwrite contact type or notes for an existing channel", async () => {
    queryRows = [
      {
        channelId: "ch-bot",
        contactId: "co-bot",
        channelStatus: "unverified",
      },
    ];

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBOT99",
      contactType: "assistant",
      notes: "Automated Slack bot",
    });

    // The existing-channel branch upserts identity only — contactType/notes are
    // omitted so guardian-authored classification is never clobbered.
    const upsert = mirrorUpserts()[0];
    expect(upsert).toBeTruthy();
    expect(upsert!.body.contactType).toBeUndefined();
    expect(upsert!.body.notes).toBeUndefined();
  });
});

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

mock.module("../db/connection.js", () => ({
  getGatewayDb: () => ({
    update: () => ({ set: () => ({ where: () => ({ run: () => {} }) }) }),
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ run: () => {} }) }),
    }),
  }),
}));

mock.module("../db/schema.js", () => ({
  contactChannels: "contactChannels",
  contacts: "contacts",
}));

mock.module("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
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
});

describe("upsertContactChannel — channel address casing", () => {
  test("preserves Slack actor ID casing when seeding an inbound contact channel", async () => {
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
    expect(channelInsert!.params[3]).toBe("U123EXAMPLE");
    expect(channelInsert!.params[4]).toBe("U123EXAMPLE");

    expect(queryCalls[0]!.sql).toContain("CASE WHEN cc.address = ?");
    expect(queryCalls[0]!.params).toEqual([
      "slack",
      "U123EXAMPLE",
      "U123EXAMPLE",
      "U123EXAMPLE",
    ]);
  });
});

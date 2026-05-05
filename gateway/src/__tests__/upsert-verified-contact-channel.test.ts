/**
 * Tests for upsertVerifiedContactChannel: must not reactivate
 * revoked or blocked channels.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

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
const runCalls: { sql: string; params: unknown[] }[] = [];

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: async (_sql: string, _params: unknown[]) => queryRows,
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
  resolveIpcSocketPath: () => ({ path: "/tmp/test.sock" }),
}));

// Import after mocks
const { upsertVerifiedContactChannel } = await import(
  "../verification/contact-helpers.js"
);

beforeEach(() => {
  queryRows = [];
  runCalls.length = 0;
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

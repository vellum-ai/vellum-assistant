/**
 * Tests for ATL-434: upsertVerifiedContactChannel must not reactivate
 * revoked channels or touch channels that belong to guardian contacts.
 */

import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";

import "./test-preload.js";

// ---------------------------------------------------------------------------
// DB mock — configurable per test
// ---------------------------------------------------------------------------

type ExistingRow = {
  channelId: string;
  contactId: string;
  channelStatus: string;
  contactRole: string;
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

describe("upsertVerifiedContactChannel — guardian and revoked guards", () => {
  test("skips update when existing channel is revoked", async () => {
    queryRows = [
      {
        channelId: "ch-1",
        contactId: "co-1",
        channelStatus: "revoked",
        contactRole: "contact",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    // No UPDATE should have been issued
    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("skips update when existing channel belongs to a guardian contact", async () => {
    queryRows = [
      {
        channelId: "ch-2",
        contactId: "co-2",
        channelStatus: "active",
        contactRole: "guardian",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("skips update when revoked channel belongs to a guardian contact", async () => {
    queryRows = [
      {
        channelId: "ch-3",
        contactId: "co-3",
        channelStatus: "revoked",
        contactRole: "guardian",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("skips update when channel is blocked (pre-existing guard)", async () => {
    queryRows = [
      {
        channelId: "ch-4",
        contactId: "co-4",
        channelStatus: "blocked",
        contactRole: "contact",
      },
    ];

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550001111",
      externalChatId: "+15550001111",
    });

    expect(runCalls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("updates an active channel belonging to a non-guardian contact", async () => {
    queryRows = [
      {
        channelId: "ch-5",
        contactId: "co-5",
        channelStatus: "active",
        contactRole: "contact",
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
    queryRows = []; // no existing channel

    await upsertVerifiedContactChannel({
      sourceChannel: "phone",
      externalUserId: "+15550009999",
      externalChatId: "+15550009999",
    });

    const inserts = runCalls.filter((c) => c.sql.includes("INSERT"));
    expect(inserts).toHaveLength(2); // one for contacts, one for contact_channels
  });
});

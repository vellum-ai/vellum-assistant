/**
 * Tests for the mark_channel_verified IPC handler in contact-handlers.
 *
 * The handler delegates to ContactStore.markChannelVerified and projects the
 * result into the contract-shaped envelope. The assistant DB proxy is mocked
 * behind a per-test fake so the not-found and assistant-mirror paths can be
 * exercised without a running daemon.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";

import "./test-preload.js";

type FakeChannelRow = {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  is_primary: number;
  external_chat_id: string | null;
  status: string;
  policy: string;
  verified_at: number | null;
  verified_via: string | null;
  invite_id: string | null;
  revoked_reason: string | null;
  blocked_reason: string | null;
  last_seen_at: number | null;
  interaction_count: number;
  last_interaction: number | null;
  created_at: number;
  updated_at: number | null;
};

type FakeContactRow = {
  id: string;
  display_name: string;
  role: string | null;
  principal_id: string | null;
  created_at: number;
  updated_at: number | null;
};

const fakeAssistantDb = {
  channels: new Map<string, FakeChannelRow>(),
  contacts: new Map<string, FakeContactRow>(),
  reset(): void {
    this.channels.clear();
    this.contacts.clear();
  },
};

// Mock the assistant DB proxy before importing the handlers. The fake honors
// `SELECT ... FROM contact_channels WHERE id = ?` and
// `SELECT ... FROM contacts WHERE id = ?`; all other SELECTs return [].
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbRun: mock(async () => ({ changes: 1, lastInsertRowid: 0 })),
  assistantDbQuery: mock(async (sql: string, bind?: unknown[]) => {
    const lower = sql.toLowerCase();
    if (lower.includes("from contact_channels")) {
      const id = String(bind?.[0] ?? "");
      const row = fakeAssistantDb.channels.get(id);
      return row ? [row] : [];
    }
    if (lower.includes("from contacts")) {
      const id = String(bind?.[0] ?? "");
      const row = fakeAssistantDb.contacts.get(id);
      return row ? [row] : [];
    }
    return [];
  }),
  assistantDbExec: mock(async () => undefined),
}));

import { eq } from "drizzle-orm";

import { contactRoutes } from "../ipc/contact-handlers.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

const markChannelVerifiedHandler = contactRoutes.find(
  (r) => r.method === "mark_channel_verified",
)!.handler;

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  fakeAssistantDb.reset();
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string, role: "guardian" | "contact" = "guardian") {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `name-${id}`,
      role,
      principalId: `prin-${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedChannel(opts: { id: string; contactId: string; status?: string }) {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.id,
      contactId: opts.contactId,
      type: "vellum",
      address: `addr-${opts.id}`,
      isPrimary: false,
      status: opts.status ?? "unverified",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedAssistantContact(id: string, role: string = "guardian"): void {
  fakeAssistantDb.contacts.set(id, {
    id,
    display_name: `name-${id}`,
    role,
    principal_id: `prin-${id}`,
    created_at: 100,
    updated_at: 100,
  });
}

function seedAssistantChannel(opts: {
  id: string;
  contactId: string;
  status?: string;
}): void {
  fakeAssistantDb.channels.set(opts.id, {
    id: opts.id,
    contact_id: opts.contactId,
    type: "vellum",
    address: `addr-${opts.id}`,
    is_primary: 0,
    external_chat_id: null,
    status: opts.status ?? "unverified",
    policy: "allow",
    verified_at: null,
    verified_via: null,
    invite_id: null,
    revoked_reason: null,
    blocked_reason: null,
    last_seen_at: null,
    interaction_count: 0,
    last_interaction: null,
    created_at: 100,
    updated_at: 100,
  });
}

describe("mark_channel_verified IPC handler", () => {
  test("flips a seeded unverified channel to active + verified_via=challenge and returns the envelope", async () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const before = Date.now();
    const res = (await markChannelVerifiedHandler({
      contactChannelId: "ch1",
    })) as {
      ok: boolean;
      didWrite: boolean;
      channel: {
        id: string;
        contactId: string;
        type: string;
        address: string;
        status: string;
        verifiedAt: number | null;
        verifiedVia: string | null;
      };
    };

    // (b) response envelope is well-formed
    expect(res.ok).toBe(true);
    expect(res.didWrite).toBe(true);
    expect(res.channel).toEqual({
      id: "ch1",
      contactId: "c1",
      type: "vellum",
      address: "addr-ch1",
      status: "active",
      verifiedAt: res.channel.verifiedAt,
      verifiedVia: "challenge",
    });

    // (a) gateway DB row flipped to active / challenge / verified_at set
    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("active");
    expect(row!.verifiedVia).toBe("challenge");
    expect(row!.verifiedAt!).toBeGreaterThanOrEqual(before);
  });

  test("throws on a missing channel id (no silent success)", async () => {
    await expect(
      markChannelVerifiedHandler({ contactChannelId: "nonexistent" }),
    ).rejects.toThrow(/not found/);
  });

  test("inherits assistant-mirror behavior: a gateway-absent channel is mirrored then verified", async () => {
    seedAssistantContact("c1");
    seedAssistantChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const res = (await markChannelVerifiedHandler({
      contactChannelId: "ch1",
    })) as { ok: boolean; didWrite: boolean; channel: { status: string } };

    expect(res.ok).toBe(true);
    expect(res.didWrite).toBe(true);
    expect(res.channel.status).toBe("active");

    // Channel + parent contact were materialized into the gateway DB.
    const channelInGateway = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(channelInGateway).toBeTruthy();
    expect(channelInGateway!.contactId).toBe("c1");
  });
});

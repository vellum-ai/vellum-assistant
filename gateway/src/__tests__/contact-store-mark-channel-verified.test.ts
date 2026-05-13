/**
 * Tests for ContactStore.markChannelVerified — manual channel verification
 * flow used by the /v1/contact-channels/:id/verify endpoint.
 *
 * The assistant DB proxy is mocked behind a per-test fake (`fakeAssistantDb`)
 * so tests can stage either an empty assistant DB (most cases) or a
 * pre-populated one (mirror-from-assistant cases) without spinning up a
 * daemon.
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

type FakeChannelRow = {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  is_primary: number;
  external_user_id: string | null;
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
  runCalls: [] as { sql: string; bind?: unknown[] }[],
  reset(): void {
    this.channels.clear();
    this.contacts.clear();
    this.runCalls = [];
  },
};

// Mock the assistant DB proxy before importing ContactStore. The fake
// honors `SELECT ... FROM contact_channels WHERE id = ?` and
// `SELECT ... FROM contacts WHERE id = ?`; all other SELECTs return [].
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbRun: mock(async (sql: string, bind?: unknown[]) => {
    fakeAssistantDb.runCalls.push({ sql, bind });
    return { changes: 1, lastInsertRowid: 0 };
  }),
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

import { ContactStore } from "../db/contact-store.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  fakeAssistantDb.reset();
});

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
    external_user_id: null,
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

function seedChannel(opts: {
  id: string;
  contactId: string;
  status?: string;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
}) {
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
      verifiedAt: opts.verifiedAt ?? null,
      verifiedVia: opts.verifiedVia ?? null,
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("ContactStore.markChannelVerified", () => {
  test("returns null when neither side has the channel", async () => {
    const store = new ContactStore();
    expect(await store.markChannelVerified("missing-id")).toBeNull();
  });

  test("flips an unverified channel to active+verifiedVia=manual", async () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const before = Date.now();
    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt).not.toBeNull();
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);
  });

  test("is idempotent on an already-verified channel (no second write)", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "active",
      verifiedAt: 1000,
      verifiedVia: "manual",
    });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(false);
    // verifiedAt must NOT have moved
    expect(result!.channel.verifiedAt).toBe(1000);
    expect(result!.channel.verifiedVia).toBe("manual");
  });

  test("upgrades a previously challenge-verified channel to manual", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "active",
      verifiedAt: 500,
      verifiedVia: "challenge",
    });

    const before = Date.now();
    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);
  });

  test("re-activates a non-active channel that previously had verifiedAt", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "revoked",
      verifiedAt: 500,
      verifiedVia: "challenge",
    });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
  });

  test("two successive calls only write once", async () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const store = new ContactStore();
    const a = await store.markChannelVerified("ch1");
    const b = await store.markChannelVerified("ch1");
    expect(a!.didWrite).toBe(true);
    expect(b!.didWrite).toBe(false);
    // Same verifiedAt — predicate prevented re-stamping
    expect(b!.channel.verifiedAt).toBe(a!.channel.verifiedAt);
  });

  test("mirrors channel + contact from assistant DB when gateway is empty, then verifies", async () => {
    seedAssistantContact("c1");
    seedAssistantChannel({
      id: "ch1",
      contactId: "c1",
      status: "unverified",
    });

    const before = Date.now();
    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);

    // Channel + contact were materialized in the gateway DB.
    const channelInGateway = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(channelInGateway).toBeTruthy();
    expect(channelInGateway!.contactId).toBe("c1");
    expect(channelInGateway!.type).toBe("vellum");
    const contactInGateway = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.id, "c1"))
      .get();
    expect(contactInGateway).toBeTruthy();
    expect(contactInGateway!.displayName).toBe("name-c1");
    expect(contactInGateway!.role).toBe("guardian");
  });

  test("refuses to mirror when assistant channel references a missing contact", async () => {
    // Channel present, parent contact absent — broken state, refuse silently.
    seedAssistantChannel({ id: "ch1", contactId: "orphan", status: "unverified" });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).toBeNull();

    // Nothing landed in the gateway.
    const channelInGateway = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(channelInGateway).toBeUndefined();
  });

  test("mirror is idempotent across successive calls", async () => {
    seedAssistantContact("c1");
    seedAssistantChannel({
      id: "ch1",
      contactId: "c1",
      status: "unverified",
    });

    const store = new ContactStore();
    const first = await store.markChannelVerified("ch1");
    const second = await store.markChannelVerified("ch1");
    expect(first!.didWrite).toBe(true);
    expect(second!.didWrite).toBe(false);
    expect(second!.channel.verifiedAt).toBe(first!.channel.verifiedAt);
    // Mirror INSERT OR IGNORE: still exactly one channel row, one contact row.
    expect(
      getGatewayDb().select().from(contactChannels).all().length,
    ).toBe(1);
    expect(getGatewayDb().select().from(contacts).all().length).toBe(1);
  });

  test("gateway-present channel takes precedence over assistant copy (no mirror, no overwrite)", async () => {
    // Gateway has the row (with a custom display_name for the contact);
    // assistant has a different display_name. We should verify the gateway
    // row in place — not overwrite gateway state with the assistant copy.
    const now = Date.now();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "c1",
        displayName: "gateway-name",
        role: "guardian",
        principalId: "prin-c1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });
    seedAssistantContact("c1");
    seedAssistantChannel({
      id: "ch1",
      contactId: "c1",
      status: "unverified",
    });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");

    const contactRow = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.id, "c1"))
      .get();
    expect(contactRow!.displayName).toBe("gateway-name");
  });
});

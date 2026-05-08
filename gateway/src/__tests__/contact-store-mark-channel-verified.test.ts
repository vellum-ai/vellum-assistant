/**
 * Tests for ContactStore.markChannelVerified — gateway-DB-only manual
 * channel verification flow used by the /v1/contact-channels/:id/verify
 * endpoint.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";

import "./test-preload.js";

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
  test("returns null when the channel does not exist", () => {
    const store = new ContactStore();
    expect(store.markChannelVerified("missing-id")).toBeNull();
  });

  test("flips an unverified channel to active+verifiedVia=manual", () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const before = Date.now();
    const result = new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt).not.toBeNull();
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);
  });

  test("is idempotent on an already-verified channel (no second write)", () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "active",
      verifiedAt: 1000,
      verifiedVia: "manual",
    });

    const result = new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(false);
    // verifiedAt must NOT have moved
    expect(result!.channel.verifiedAt).toBe(1000);
    expect(result!.channel.verifiedVia).toBe("manual");
  });

  test("upgrades a previously challenge-verified channel to manual", () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "active",
      verifiedAt: 500,
      verifiedVia: "challenge",
    });

    const before = Date.now();
    const result = new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);
  });

  test("re-activates a non-active channel that previously had verifiedAt", () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "revoked",
      verifiedAt: 500,
      verifiedVia: "challenge",
    });

    const result = new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
  });

  test("two successive calls only write once", () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const store = new ContactStore();
    const a = store.markChannelVerified("ch1");
    const b = store.markChannelVerified("ch1");
    expect(a!.didWrite).toBe(true);
    expect(b!.didWrite).toBe(false);
    // Same verifiedAt — predicate prevented re-stamping
    expect(b!.channel.verifiedAt).toBe(a!.channel.verifiedAt);
  });
});

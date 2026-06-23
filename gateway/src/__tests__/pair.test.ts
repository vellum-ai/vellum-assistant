/**
 * Tests for resolveLocalGuardianPrincipalId — the pair endpoint's local
 * guardian principal lookup. The lookup reads the gateway DB directly:
 * a seeded vellum active guardian resolves its principal; an empty DB (or a
 * read failure) falls back to "local".
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

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";
import { resolveLocalGuardianPrincipalId } from "../http/routes/pair.js";

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

function seedGuardian(opts: {
  contactId: string;
  principalId: string | null;
  channelType?: string;
  channelStatus?: string;
  role?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.contactId,
      displayName: `name-${opts.contactId}`,
      role: opts.role ?? "guardian",
      principalId: opts.principalId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: `ch-${opts.contactId}`,
      contactId: opts.contactId,
      type: opts.channelType ?? "vellum",
      address: `addr-${opts.contactId}`,
      isPrimary: false,
      status: opts.channelStatus ?? "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("resolveLocalGuardianPrincipalId", () => {
  test("returns the principal of a vellum active guardian seeded in the gateway DB", async () => {
    seedGuardian({ contactId: "guardian-1", principalId: "principal-owner" });
    expect(await resolveLocalGuardianPrincipalId()).toBe("principal-owner");
  });

  test("falls back to 'local' on an empty gateway DB", async () => {
    expect(await resolveLocalGuardianPrincipalId()).toBe("local");
  });

  test("falls back to 'local' when the vellum guardian channel is not active", async () => {
    seedGuardian({
      contactId: "guardian-2",
      principalId: "principal-owner",
      channelStatus: "unverified",
    });
    expect(await resolveLocalGuardianPrincipalId()).toBe("local");
  });

  test("falls back to 'local' when the active guardian channel is non-vellum", async () => {
    seedGuardian({
      contactId: "guardian-3",
      principalId: "principal-owner",
      channelType: "slack",
    });
    expect(await resolveLocalGuardianPrincipalId()).toBe("local");
  });
});

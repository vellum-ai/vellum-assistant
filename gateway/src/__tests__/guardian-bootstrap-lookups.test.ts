/**
 * Tests for guardian-bootstrap pure guardian lookups
 * (findVellumGuardian + findGuardianForChannelActor) after they were
 * repointed to read the gateway DB directly.
 *
 * Guardian rows are seeded ONLY in the gateway DB. The assistant DB proxy is
 * mocked to throw, proving the lookups no longer depend on the assistant mirror.
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

// Assistant DB proxy throws — the gateway reads must not touch it.
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async () => {
    throw new Error("assistant DB must not be read by guardian lookups");
  }),
  assistantDbRun: mock(async () => ({ changes: 0, lastInsertRowid: 0 })),
  assistantDbExec: mock(async () => undefined),
}));

import {
  findVellumGuardian,
  findGuardianForChannelActor,
} from "../auth/guardian-bootstrap.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

function seedGuardianChannel(opts: {
  type: string;
  address: string;
  status?: string;
  verifiedAt?: number | null;
  principalId?: string | null;
  contactId?: string;
  channelId?: string;
  role?: string;
}): void {
  const now = Date.now();
  const contactId = opts.contactId ?? `contact-${opts.address}`;
  getGatewayDb()
    .insert(contacts)
    .values({
      id: contactId,
      displayName: `name-${contactId}`,
      role: opts.role ?? "guardian",
      principalId:
        opts.principalId === undefined ? `prin-${contactId}` : opts.principalId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.channelId ?? `channel-${opts.address}`,
      contactId,
      type: opts.type,
      address: opts.address,
      isPrimary: true,
      status: opts.status ?? "active",
      policy: "allow",
      verifiedAt: opts.verifiedAt ?? now,
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

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

describe("findVellumGuardian (gateway DB)", () => {
  test("resolves a guardian seeded only in the gateway DB", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-principal-1",
      principalId: "principal-owner",
    });

    const result = await findVellumGuardian();
    expect(result).toEqual({ principalId: "principal-owner" });
  });

  test("returns null when no active vellum guardian channel exists", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-principal-1",
      status: "revoked",
      principalId: "principal-owner",
    });

    expect(await findVellumGuardian()).toBeNull();
  });

  test("returns null when the gateway DB is empty", async () => {
    expect(await findVellumGuardian()).toBeNull();
  });

  test("prefers the most recently verified guardian channel", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-old",
      contactId: "contact-old",
      channelId: "channel-old",
      verifiedAt: 1000,
      principalId: "principal-old",
    });
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-new",
      contactId: "contact-new",
      channelId: "channel-new",
      verifiedAt: 2000,
      principalId: "principal-new",
    });

    const result = await findVellumGuardian();
    expect(result).toEqual({ principalId: "principal-new" });
  });
});

describe("findGuardianForChannelActor (gateway DB)", () => {
  test("resolves an active guardian binding seeded only in the gateway DB", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_OWNER",
      principalId: "principal-owner",
    });

    const result = await findGuardianForChannelActor("slack", "U_OWNER");
    expect(result).toEqual({ principalId: "principal-owner" });
  });

  test("matches the address case-insensitively (COLLATE NOCASE)", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_Owner",
      principalId: "principal-owner",
    });

    const result = await findGuardianForChannelActor("slack", "u_owner");
    expect(result).toEqual({ principalId: "principal-owner" });
  });

  test("returns null when no active guardian channel matches", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_OWNER",
      status: "revoked",
      principalId: "principal-owner",
    });

    expect(await findGuardianForChannelActor("slack", "U_OWNER")).toBeNull();
    expect(await findGuardianForChannelActor("slack", "U_UNKNOWN")).toBeNull();
  });

  test("does not match a non-guardian contact on the same channel", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_OWNER",
      role: "contact",
      principalId: "principal-owner",
    });

    expect(await findGuardianForChannelActor("slack", "U_OWNER")).toBeNull();
  });

  test("returns null for empty inputs without reading any DB", async () => {
    expect(await findGuardianForChannelActor("", "U_OWNER")).toBeNull();
    expect(await findGuardianForChannelActor("slack", "")).toBeNull();
  });
});

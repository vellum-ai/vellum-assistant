/**
 * Tests for POST /v1/contacts/guardian/channel endpoint.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

// Auth is disabled in tests by default (no VELLUM_JWT_SECRET), so
// requireBoundGuardian bypasses. We mock isHttpAuthDisabled to control it.
let authDisabled = true;
mock.module("../../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  getAssistantDomain: () => "vellum.me",
}));

import { and, eq } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { contactChannels, contacts } from "../../memory/schema.js";
import type { AuthContext } from "../auth/types.js";
import { handleAddGuardianChannel } from "./contact-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/v1/contacts/guardian/channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    subject: "test-subject",
    principalType: "actor",
    assistantId: "test-assistant",
    actorPrincipalId: "guardian-principal-001",
    scopeProfile: "actor_client_v1",
    scopes: new Set(),
    policyEpoch: 0,
    ...overrides,
  } as AuthContext;
}

function seedGuardian(
  displayName = "Test Guardian",
  principalId = "guardian-principal-001",
): { contactId: string } {
  const db = getDb();
  const contactId = "guardian-001";
  db.insert(contacts)
    .values({
      id: contactId,
      displayName,
      role: "guardian",
      contactType: "human",
      principalId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();

  // Add a pre-existing channel (e.g. Telegram) so the guardian is verified
  db.insert(contactChannels)
    .values({
      id: "ch-telegram-001",
      contactId,
      type: "telegram",
      address: "@testguardian",
      externalUserId: principalId,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();

  return { contactId };
}

function seedVellumGuardianChannel(
  contactId: string,
  principalId: string,
): void {
  const db = getDb();
  db.insert(contactChannels)
    .values({
      id: "ch-vellum-001",
      contactId,
      type: "vellum",
      address: principalId,
      externalUserId: principalId,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/contacts/guardian/channel", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(contactChannels).run();
    db.delete(contacts).run();
    authDisabled = true;
  });

  test("adds an email channel to an existing guardian", async () => {
    const { contactId } = seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeAuthContext(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      contact: { id: string };
    };
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe(contactId);

    // Verify channel was persisted
    const db = getDb();
    const rows = db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.contactId, contactId),
          eq(contactChannels.type, "email"),
        ),
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].address).toBe("owner@example.com");
    expect(rows[0].status).toBe("active");
  });

  test("returns 404 when no guardian exists", async () => {
    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeAuthContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("No guardian contact exists");
  });

  test("returns 400 when type is missing", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({ address: "owner@example.com" }),
      makeAuthContext(),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when address is missing", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({ type: "email", externalUserId: "owner@example.com" }),
      makeAuthContext(),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when externalUserId is missing", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({ type: "email", address: "owner@example.com" }),
      makeAuthContext(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("externalUserId is required");
  });

  test("preserves existing channels when adding new ones", async () => {
    const { contactId } = seedGuardian();

    await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeAuthContext(),
    );

    // Guardian should still have the telegram channel + new email channel
    const db = getDb();
    const rows = db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.contactId, contactId))
      .all();

    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(["email", "telegram"]);
  });

  test("defaults channel status to active", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeAuthContext(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      contact: { channels: { type: string; status: string }[] };
    };
    const emailChannel = body.contact.channels.find(
      (ch) => ch.type === "email",
    );
    expect(emailChannel?.status).toBe("active");
  });

  test("returns 403 when a non-guardian verified contact calls the endpoint", async () => {
    authDisabled = false;
    const guardianPrincipalId = "guardian-principal-001";
    const { contactId } = seedGuardian("Guardian", guardianPrincipalId);
    seedVellumGuardianChannel(contactId, guardianPrincipalId);

    // Caller is a different principal — not the guardian
    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "intruder@example.com",
        externalUserId: "intruder@example.com",
      }),
      makeAuthContext({ actorPrincipalId: "some-other-principal" }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

/**
 * Tests for POST /v1/contacts/guardian/channel endpoint.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

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

mock.module("../../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getAssistantDomain: () => "vellum.me",
}));

import { and, eq } from "drizzle-orm";

import { getDb, initializeDb } from "../../memory/db.js";
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

function makeServiceAuthContext(
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    subject: "platform-service",
    principalType: "svc_gateway",
    assistantId: "test-assistant",
    actorPrincipalId: undefined,
    scopeProfile: "gateway_service_v1",
    scopes: new Set(),
    policyEpoch: 0,
    ...overrides,
  } as AuthContext;
}

function makeActorAuthContext(
  overrides: Partial<AuthContext> = {},
): AuthContext {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/contacts/guardian/channel", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(contactChannels).run();
    db.delete(contacts).run();
  });

  // ── Service token (platform) calls — the only permitted path ────────────

  test("adds an email channel to an existing guardian (service auth)", async () => {
    const { contactId } = seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeServiceAuthContext(),
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

  test("returns 404 when no guardian exists (service auth)", async () => {
    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeServiceAuthContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("No guardian contact exists");
  });

  test("returns 400 when type is missing (service auth)", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({ address: "owner@example.com" }),
      makeServiceAuthContext(),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when address is missing (service auth)", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({ type: "email", externalUserId: "owner@example.com" }),
      makeServiceAuthContext(),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when externalUserId is missing (service auth)", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({ type: "email", address: "owner@example.com" }),
      makeServiceAuthContext(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("externalUserId is required");
  });

  test("preserves existing channels when adding new ones (service auth)", async () => {
    const { contactId } = seedGuardian();

    await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeServiceAuthContext(),
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

  test("defaults channel status to active (service auth)", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeServiceAuthContext(),
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

  // ── Actor calls — all rejected (security fix ATL-102) ──────────────────

  test("rejects actor calls with 403 (guardian takeover prevention)", async () => {
    seedGuardian();

    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "owner@example.com",
        externalUserId: "owner@example.com",
      }),
      makeActorAuthContext(),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("restricted to platform service");
  });

  test("rejects actor calls even from the bound guardian", async () => {
    const guardianPrincipalId = "guardian-principal-001";
    seedGuardian("Guardian", guardianPrincipalId);

    // Caller IS the guardian — but actor calls are still rejected
    const res = await handleAddGuardianChannel(
      makeRequest({
        type: "email",
        address: "guardian@example.com",
        externalUserId: "guardian@example.com",
      }),
      makeActorAuthContext({ actorPrincipalId: guardianPrincipalId }),
    );

    expect(res.status).toBe(403);
  });
});

import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";

import "../../__tests__/test-preload.js";

// --- Mocks ----------------------------------------------------------------

const assistantDbQueryMock = mock(
  (_sql: string, _params?: unknown[]) =>
    Promise.resolve([] as Record<string, unknown>[]),
);

const createGuardianBindingMock = mock((_params: unknown) =>
  Promise.resolve({
    contactId: "contact-1",
    channelId: "channel-1",
    guardianPrincipalId: "principal-1",
    channel: "email",
  }),
);

mock.module("../../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: assistantDbQueryMock,
  assistantDbRun: mock(() => Promise.resolve()),
  assistantDbExec: mock(() => Promise.resolve()),
}));

mock.module("../../auth/guardian-bootstrap.js", () => ({
  createGuardianBinding: createGuardianBindingMock,
}));

// Import after mocks are registered
const { createGuardianChannelHandler } = await import(
  "./guardian-channel-create.js"
);
const { initGatewayDb, getGatewayDb, resetGatewayDb } = await import(
  "../../db/connection.js"
);
const { contacts, contactChannels } = await import("../../db/schema.js");

// --- Helpers ---------------------------------------------------------------

function postRequest(body: unknown): Request {
  return new Request("http://localhost:7830/v1/contacts/guardian/channel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Seed a guardian contact in the gateway DB so findGuardian() resolves it.
function seedGuardian(principalId: string | null): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "guardian-1",
      displayName: "guardian",
      role: "guardian",
      principalId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// --- Tests -----------------------------------------------------------------

describe("POST /v1/contacts/guardian/channel", () => {
  beforeAll(async () => {
    await initGatewayDb();
  });

  afterAll(() => {
    resetGatewayDb();
  });

  beforeEach(() => {
    const db = getGatewayDb();
    db.delete(contactChannels).run();
    db.delete(contacts).run();

    assistantDbQueryMock.mockReset();
    createGuardianBindingMock.mockReset();

    createGuardianBindingMock.mockResolvedValue({
      contactId: "contact-1",
      channelId: "channel-1",
      guardianPrincipalId: "principal-1",
      channel: "email",
    });
  });

  it("creates a guardian channel binding and returns 200", async () => {
    seedGuardian("principal-1");

    const handler = createGuardianChannelHandler();
    const res = await handler(
      postRequest({
        type: "email",
        address: "user@example.com",
        externalUserId: "user@example.com",
        status: "active",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; verified_via: string };
    expect(body.ok).toBe(true);
    expect(body.verified_via).toBe("platform_auto_register");

    // Verify createGuardianBinding was called with correct params
    expect(createGuardianBindingMock).toHaveBeenCalledTimes(1);
    const callArgs = createGuardianBindingMock.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(callArgs.channel).toBe("email");
    expect(callArgs.externalUserId).toBe("user@example.com");
    // CRITICAL: deliveryChatId must be externalUserId, not address
    expect(callArgs.deliveryChatId).toBe("user@example.com");
    expect(callArgs.guardianPrincipalId).toBe("principal-1");
    expect(callArgs.displayName).toBe("user@example.com");
    expect(callArgs.verifiedVia).toBe("platform_auto_register");
  });

  it("returns 404 when no guardian contact exists", async () => {
    // Empty gateway DB — no guardian row seeded.

    const handler = createGuardianChannelHandler();
    const res = await handler(
      postRequest({
        type: "email",
        address: "user@example.com",
        externalUserId: "user@example.com",
        status: "active",
      }),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("No guardian contact exists");
    expect(createGuardianBindingMock).not.toHaveBeenCalled();
  });

  it("returns 404 when guardian has no principal_id", async () => {
    seedGuardian(null);

    const handler = createGuardianChannelHandler();
    const res = await handler(
      postRequest({
        type: "email",
        address: "user@example.com",
        externalUserId: "user@example.com",
        status: "active",
      }),
    );

    expect(res.status).toBe(404);
    expect(createGuardianBindingMock).not.toHaveBeenCalled();
  });

  it("returns 400 on missing required fields", async () => {
    const handler = createGuardianChannelHandler();
    const res = await handler(
      postRequest({
        type: "email",
        // missing address, externalUserId, status
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("Validation failed");
    expect(body.issues).toBeDefined();
  });

  it("returns 400 when status is not 'active'", async () => {
    const handler = createGuardianChannelHandler();
    const res = await handler(
      postRequest({
        type: "email",
        address: "user@example.com",
        externalUserId: "user@example.com",
        status: "pending",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 on invalid JSON body", async () => {
    const handler = createGuardianChannelHandler();
    const res = await handler(
      new Request("http://localhost:7830/v1/contacts/guardian/channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 500 when createGuardianBinding throws", async () => {
    seedGuardian("principal-1");
    createGuardianBindingMock.mockRejectedValue(new Error("DB write failed"));

    const handler = createGuardianChannelHandler();
    const res = await handler(
      postRequest({
        type: "email",
        address: "user@example.com",
        externalUserId: "user@example.com",
        status: "active",
      }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to create guardian channel");
  });
});

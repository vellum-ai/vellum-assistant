/**
 * Tests for the gateway invite CRUD IPC routes (invites_list / invites_create /
 * invites_revoke / invites_trigger_call).
 *
 * Each route is driven directly through its handler. The shared native
 * functions from the HTTP module are mocked so these tests focus on the IPC
 * concerns: param validation (bad params throw) and that each route delegates
 * to its native function with the right params + returns its result shape.
 *
 * Behavioral parity of the native functions themselves with the HTTP handlers
 * is covered by contacts-control-plane-proxy.test.ts (which exercises the same
 * functions through the HTTP handlers).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Native function mocks (the single shared implementation) ──────────────────
type ListFn = (query: unknown) => Promise<{
  invites: Array<Record<string, unknown>>;
}>;
let listInvitesNativeMock: ReturnType<typeof mock<ListFn>> = mock(async () => ({
  invites: [],
}));

type CreateFn = (input: unknown) => Promise<{
  invite: Record<string, unknown>;
  rawToken?: string;
}>;
let createInviteNativeMock: ReturnType<typeof mock<CreateFn>> = mock(
  async () => ({ invite: { id: "inv_1" }, rawToken: "raw" }),
);

type RevokeFn = (id: string) => Promise<{ invite: Record<string, unknown> }>;
let revokeInviteNativeMock: ReturnType<typeof mock<RevokeFn>> = mock(
  async () => ({ invite: { id: "inv_1", status: "revoked" } }),
);

type TriggerFn = (id: string) => Promise<{ callSid: string }>;
let triggerInviteCallNativeMock: ReturnType<typeof mock<TriggerFn>> = mock(
  async () => ({ callSid: "CA123" }),
);

mock.module("../../http/routes/contacts-control-plane-proxy.js", () => ({
  listInvitesNative: (...args: Parameters<ListFn>) =>
    listInvitesNativeMock(...args),
  createInviteNative: (...args: Parameters<CreateFn>) =>
    createInviteNativeMock(...args),
  revokeInviteNative: (...args: Parameters<RevokeFn>) =>
    revokeInviteNativeMock(...args),
  triggerInviteCallNative: (...args: Parameters<TriggerFn>) =>
    triggerInviteCallNativeMock(...args),
}));

// ContactStore is only touched by the record_invite_redemption route; stub it
// so importing the module never opens a real DB.
mock.module("../db/contact-store.js", () => ({
  ContactStore: class MockContactStore {
    recordInviteRedemption() {
      return { updated: true, row: null };
    }
  },
}));

const { inviteRoutes } = await import("../invite-handlers.js");

function route(method: string) {
  const found = inviteRoutes.find((r) => r.method === method);
  if (!found) throw new Error(`route not registered: ${method}`);
  return found;
}

beforeEach(() => {
  listInvitesNativeMock = mock(async () => ({ invites: [] }));
  createInviteNativeMock = mock(async () => ({
    invite: { id: "inv_1" },
    rawToken: "raw",
  }));
  revokeInviteNativeMock = mock(async () => ({
    invite: { id: "inv_1", status: "revoked" },
  }));
  triggerInviteCallNativeMock = mock(async () => ({ callSid: "CA123" }));
});

describe("invite CRUD IPC routes registration", () => {
  test("registers all four CRUD methods alongside record_invite_redemption", () => {
    const methods = inviteRoutes.map((r) => r.method);
    expect(methods).toContain("record_invite_redemption");
    expect(methods).toContain("invites_list");
    expect(methods).toContain("invites_create");
    expect(methods).toContain("invites_revoke");
    expect(methods).toContain("invites_trigger_call");
    // No redeem IPC method — redemption stays on record_invite_redemption.
    expect(methods).not.toContain("invites_redeem");
  });

  test("every CRUD route carries a Zod param schema", () => {
    for (const m of [
      "invites_list",
      "invites_create",
      "invites_revoke",
      "invites_trigger_call",
    ]) {
      expect(route(m).schema).toBeDefined();
    }
  });
});

describe("invites_list", () => {
  test("accepts an empty filter and returns { invites }", async () => {
    listInvitesNativeMock = mock(async () => ({
      invites: [{ id: "inv_1" }],
    }));
    const r = route("invites_list");
    expect(r.schema?.safeParse({}).success).toBe(true);

    const result = await r.handler({});
    expect(result).toEqual({ invites: [{ id: "inv_1" }] });
    expect(listInvitesNativeMock).toHaveBeenCalledTimes(1);
  });

  test("accepts omitted params (no-filter list) and calls native with {}", async () => {
    listInvitesNativeMock = mock(async () => ({
      invites: [{ id: "inv_1" }],
    }));
    const r = route("invites_list");
    // The daemon relay's `ipcCallPersistent("invites_list")` sends no params,
    // so the server validates `undefined` against the schema before the handler.
    expect(r.schema?.safeParse(undefined).success).toBe(true);

    const result = await r.handler(undefined);
    expect(result).toEqual({ invites: [{ id: "inv_1" }] });
    expect(listInvitesNativeMock).toHaveBeenCalledTimes(1);
    expect(listInvitesNativeMock.mock.calls[0][0]).toEqual({});
  });

  test("passes sourceChannel + status through to the native function", async () => {
    const r = route("invites_list");
    expect(
      r.schema?.safeParse({ sourceChannel: "telegram", status: "active" })
        .success,
    ).toBe(true);
    await r.handler({ sourceChannel: "telegram", status: "active" });
    expect(listInvitesNativeMock.mock.calls[0][0]).toEqual({
      sourceChannel: "telegram",
      status: "active",
    });
  });

  test("rejects a non-string status param", () => {
    expect(route("invites_list").schema?.safeParse({ status: 5 }).success).toBe(
      false,
    );
  });
});

describe("invites_create", () => {
  test("validates the create body shape", () => {
    const schema = route("invites_create").schema;
    expect(
      schema?.safeParse({ contactId: "ct_1", sourceChannel: "telegram" })
        .success,
    ).toBe(true);
    // contactId required.
    expect(schema?.safeParse({ sourceChannel: "telegram" }).success).toBe(
      false,
    );
    // sourceChannel required.
    expect(schema?.safeParse({ contactId: "ct_1" }).success).toBe(false);
    // maxUses must be positive.
    expect(
      schema?.safeParse({
        contactId: "ct_1",
        sourceChannel: "telegram",
        maxUses: -1,
      }).success,
    ).toBe(false);
  });

  test("delegates to createInviteNative and returns the minted payload", async () => {
    createInviteNativeMock = mock(async () => ({
      invite: { id: "inv_1", inviteCode: "123456" },
      rawToken: "raw-token-abc",
    }));
    const result = await route("invites_create").handler({
      contactId: "ct_1",
      sourceChannel: "telegram",
      note: "hi",
    });
    expect(result).toEqual({
      invite: { id: "inv_1", inviteCode: "123456" },
      rawToken: "raw-token-abc",
    });
    expect(createInviteNativeMock.mock.calls[0][0]).toMatchObject({
      contactId: "ct_1",
      sourceChannel: "telegram",
      note: "hi",
    });
  });

  test("throws on invalid params (no native call)", async () => {
    await expect(
      route("invites_create").handler({ sourceChannel: "telegram" }),
    ).rejects.toThrow();
    expect(createInviteNativeMock).not.toHaveBeenCalled();
  });

  test("propagates a native error (e.g. contact not found)", async () => {
    createInviteNativeMock = mock(async () => {
      throw new Error('Contact "ct_x" not found');
    });
    await expect(
      route("invites_create").handler({
        contactId: "ct_x",
        sourceChannel: "telegram",
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("invites_revoke", () => {
  test("requires a non-empty id", () => {
    const schema = route("invites_revoke").schema;
    expect(schema?.safeParse({ id: "inv_1" }).success).toBe(true);
    expect(schema?.safeParse({ id: "" }).success).toBe(false);
    expect(schema?.safeParse({}).success).toBe(false);
  });

  test("delegates to revokeInviteNative and returns the sanitized invite", async () => {
    revokeInviteNativeMock = mock(async () => ({
      invite: { id: "inv_9", status: "revoked" },
    }));
    const result = await route("invites_revoke").handler({ id: "inv_9" });
    expect(result).toEqual({ invite: { id: "inv_9", status: "revoked" } });
    expect(revokeInviteNativeMock.mock.calls[0][0]).toBe("inv_9");
  });

  test("throws on missing id (no native call)", async () => {
    await expect(route("invites_revoke").handler({})).rejects.toThrow();
    expect(revokeInviteNativeMock).not.toHaveBeenCalled();
  });
});

describe("invites_trigger_call", () => {
  test("requires a non-empty id", () => {
    const schema = route("invites_trigger_call").schema;
    expect(schema?.safeParse({ id: "inv_1" }).success).toBe(true);
    expect(schema?.safeParse({}).success).toBe(false);
  });

  test("delegates to triggerInviteCallNative and returns { callSid }", async () => {
    triggerInviteCallNativeMock = mock(async () => ({ callSid: "CA999" }));
    const result = await route("invites_trigger_call").handler({ id: "inv_1" });
    expect(result).toEqual({ callSid: "CA999" });
    expect(triggerInviteCallNativeMock.mock.calls[0][0]).toBe("inv_1");
  });

  test("propagates a native error (e.g. invite not active)", async () => {
    triggerInviteCallNativeMock = mock(async () => {
      throw new Error('Invite "inv_1" is not active');
    });
    await expect(
      route("invites_trigger_call").handler({ id: "inv_1" }),
    ).rejects.toThrow(/not active/);
  });
});

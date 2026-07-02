/**
 * Tests for the gateway invite CRUD IPC routes (invites_list / invites_create /
 * invites_revoke).
 *
 * `invites_trigger_call` is intentionally NOT a gateway IPC route: it stays
 * daemon-local on the assistant. The gateway HTTP call path validates its row
 * then delegates the provider call to the assistant via triggerInviteCallNative;
 * relaying it over IPC would loop gateway→assistant→gateway.
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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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

type RedeemFn = (input: unknown) => Promise<Record<string, unknown>>;
let redeemInviteNativeMock: ReturnType<typeof mock<RedeemFn>> = mock(
  async () => ({ ok: true, type: "redeemed", memberId: "ct_1" }),
);

// Mirrors the real InviteNativeError (statusCode + code) so the invites_redeem
// route's parse rejection carries a 400 over the IPC wire.
class MockInviteNativeError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "InviteNativeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

mock.module("../../http/routes/contacts-control-plane-proxy.js", () => ({
  InviteNativeError: MockInviteNativeError,
  listInvitesNative: (...args: Parameters<ListFn>) =>
    listInvitesNativeMock(...args),
  createInviteNative: (...args: Parameters<CreateFn>) =>
    createInviteNativeMock(...args),
  revokeInviteNative: (...args: Parameters<RevokeFn>) =>
    revokeInviteNativeMock(...args),
  redeemInviteNative: (...args: Parameters<RedeemFn>) =>
    redeemInviteNativeMock(...args),
}));

// ContactStore backs the voice-invite routes; stub it so importing the module
// never opens a real DB.
mock.module("../db/contact-store.js", () => ({
  ContactStore: class MockContactStore {},
}));

const { inviteRoutes } = await import("../invite-handlers.js");
const { buildErrorResponse, buildProtocolErrorResponse, GatewayIpcServer } =
  await import("../server.js");

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
  redeemInviteNativeMock = mock(async () => ({
    ok: true,
    type: "redeemed",
    memberId: "ct_1",
  }));
});

describe("buildErrorResponse — typed-error envelope preservation", () => {
  // Mirrors InviteNativeError / IpcHandlerError: both carry
  // `statusCode: number` + `code: string`. The server duck-types these so any
  // such typed error preserves its status/code over the IPC wire.
  class TypedError extends Error {
    readonly statusCode: number;
    readonly code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  }

  test("includes statusCode + errorCode for a typed error (404)", () => {
    const err = new TypedError("Contact not found", 404, "NOT_FOUND");
    const res = buildErrorResponse("req-1", err);
    expect(res).toEqual({
      id: "req-1",
      error: String(err),
      statusCode: 404,
      errorCode: "NOT_FOUND",
    });
  });

  test("includes statusCode + errorCode for a 400 user-error", () => {
    const err = new TypedError("Invite expired", 400, "INVALID_INVITE");
    const res = buildErrorResponse("req-2", err);
    expect(res.statusCode).toBe(400);
    expect(res.errorCode).toBe("INVALID_INVITE");
    expect(res.error).toBe(String(err));
  });

  test("mirrors a structured `details` payload into errorDetails", () => {
    const err = Object.assign(
      new TypedError("Conflict", 409, "CONFLICT"),
      { details: { reason: "already_revoked" } },
    );
    const res = buildErrorResponse("req-3", err);
    expect(res.errorDetails).toEqual({ reason: "already_revoked" });
  });

  test("plain Error serializes as just { id, error } — no spurious fields", () => {
    const res = buildErrorResponse("req-4", new Error("boom"));
    expect(res).toEqual({ id: "req-4", error: "Error: boom" });
    expect("statusCode" in res).toBe(false);
    expect("errorCode" in res).toBe(false);
    expect("errorDetails" in res).toBe(false);
  });

  test("ignores non-numeric statusCode / non-string code (backward compatible)", () => {
    const err = Object.assign(new Error("weird"), {
      statusCode: "503",
      code: 42,
    });
    const res = buildErrorResponse("req-5", err);
    expect(res).toEqual({ id: "req-5", error: "Error: weird" });
  });
});

describe("buildProtocolErrorResponse — early-return validation envelope", () => {
  test("stamps statusCode + errorCode while preserving the error string", () => {
    const res = buildProtocolErrorResponse(
      "req-1",
      "Invalid params: bad",
      400,
      "BAD_REQUEST",
    );
    expect(res).toEqual({
      id: "req-1",
      error: "Invalid params: bad",
      statusCode: 400,
      errorCode: "BAD_REQUEST",
    });
  });

  test("supports a 404 for unknown methods", () => {
    const res = buildProtocolErrorResponse(
      "req-2",
      "Unknown method: nope",
      404,
      "UNKNOWN_METHOD",
    );
    expect(res.statusCode).toBe(404);
    expect(res.errorCode).toBe("UNKNOWN_METHOD");
  });
});

describe("GatewayIpcServer — protocol/validation errors carry status codes", () => {
  // Drive the server through a real Unix-domain-socket round-trip so the
  // early-return validation paths (Invalid JSON / missing fields / unknown
  // method / Zod rejection) are exercised exactly as the daemon relay hits
  // them. The relay maps `statusCode` → RouteError, so these must NOT be 500.
  let server: InstanceType<typeof GatewayIpcServer>;
  let socketDir: string;
  let prevEnv: string | undefined;

  async function rpc(line: string): Promise<Record<string, unknown>> {
    const { connect } = await import("node:net");
    return await new Promise((resolve, reject) => {
      const sock = connect(server.getSocketPath());
      let buf = "";
      sock.on("connect", () => sock.write(line + "\n"));
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          sock.end();
          resolve(JSON.parse(buf.slice(0, nl)));
        }
      });
      sock.on("error", reject);
    });
  }

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    socketDir = mkdtempSync(join(tmpdir(), "vellum-ipc-test-"));
    prevEnv = process.env.GATEWAY_IPC_SOCKET_DIR;
    process.env.GATEWAY_IPC_SOCKET_DIR = socketDir;
    // Disable the watchdog so the test has a single deterministic listener.
    server = new GatewayIpcServer(inviteRoutes, { watchdogIntervalMs: 0 });
    server.start();
    // Wait for the listener to bind.
    const { existsSync } = await import("node:fs");
    for (let i = 0; i < 100 && !existsSync(server.getSocketPath()); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  afterEach(async () => {
    server.stop();
    if (prevEnv === undefined) delete process.env.GATEWAY_IPC_SOCKET_DIR;
    else process.env.GATEWAY_IPC_SOCKET_DIR = prevEnv;
    const { rmSync } = await import("node:fs");
    rmSync(socketDir, { recursive: true, force: true });
  });

  test("Zod schema rejection → 400 BAD_REQUEST + 'Invalid params'", async () => {
    // invites_create requires contactId + sourceChannel; omit sourceChannel.
    const res = await rpc(
      JSON.stringify({
        id: "r1",
        method: "invites_create",
        params: { contactId: "ct_1" },
      }),
    );
    expect(res.id).toBe("r1");
    expect(res.statusCode).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
    expect(String(res.error)).toContain("Invalid params");
    expect(createInviteNativeMock).not.toHaveBeenCalled();
  });

  test("maxUses: 0 fails the schema → 400, not 500", async () => {
    const res = await rpc(
      JSON.stringify({
        id: "r2",
        method: "invites_create",
        params: { contactId: "ct_1", sourceChannel: "telegram", maxUses: 0 },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(500);
  });

  test("unknown method → 404 UNKNOWN_METHOD", async () => {
    const res = await rpc(
      JSON.stringify({ id: "r3", method: "does_not_exist" }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.errorCode).toBe("UNKNOWN_METHOD");
    expect(String(res.error)).toContain("Unknown method");
  });

  test("invalid JSON → 400 BAD_REQUEST", async () => {
    const res = await rpc("{not json");
    expect(res.statusCode).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
    expect(res.error).toBe("Invalid JSON");
  });

  test("missing 'id'/'method' → 400 BAD_REQUEST", async () => {
    const res = await rpc(JSON.stringify({ id: "r5" }));
    expect(res.statusCode).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
    expect(res.error).toBe("Missing 'id' or 'method' field");
  });
});

describe("invite CRUD IPC routes registration", () => {
  test("registers the CRUD, redeem, and voice-invite methods", () => {
    const methods = inviteRoutes.map((r) => r.method);
    expect(methods).toContain("invites_redeem");
    expect(methods).toContain("invites_list");
    expect(methods).toContain("invites_create");
    expect(methods).toContain("invites_revoke");
    expect(methods).toContain("get_active_voice_invite");
    expect(methods).toContain("redeem_voice_invite");
    // The redemption engine claims its own rows internally — there is no
    // standalone claim IPC method for the daemon to call.
    expect(methods).not.toContain("record_invite_redemption");
    // invites_trigger_call stays daemon-local on the assistant; relaying it
    // here would loop gateway→assistant→gateway.
    expect(methods).not.toContain("invites_trigger_call");
    expect(inviteRoutes).toHaveLength(6);
  });

  test("every route carries a Zod param schema", () => {
    for (const m of [
      "invites_redeem",
      "invites_list",
      "invites_create",
      "invites_revoke",
      "get_active_voice_invite",
      "redeem_voice_invite",
    ]) {
      expect(route(m).schema).toBeDefined();
    }
  });
});

describe("invites_redeem", () => {
  test("token params dispatch to redeemInviteNative with the parsed token input", async () => {
    redeemInviteNativeMock = mock(async () => ({
      ok: true,
      invite: { id: "inv_1" },
      type: "redeemed",
    }));
    const result = await route("invites_redeem").handler({
      token: "raw-token",
      sourceChannel: "telegram",
      externalUserId: "u_1",
    });
    expect(result).toEqual({
      ok: true,
      invite: { id: "inv_1" },
      type: "redeemed",
    });
    expect(redeemInviteNativeMock.mock.calls[0][0]).toEqual({
      kind: "token",
      token: "raw-token",
      sourceChannel: "telegram",
      externalUserId: "u_1",
      externalChatId: undefined,
    });
  });

  test("voice params dispatch to redeemInviteNative with the parsed voice input", async () => {
    redeemInviteNativeMock = mock(async () => ({
      ok: true,
      type: "redeemed",
      memberId: "ct_1",
      inviteId: "inv_1",
    }));
    const result = await route("invites_redeem").handler({
      code: "123456",
      callerExternalUserId: "+15550100001",
    });
    expect(result).toEqual({
      ok: true,
      type: "redeemed",
      memberId: "ct_1",
      inviteId: "inv_1",
    });
    expect(redeemInviteNativeMock.mock.calls[0][0]).toEqual({
      kind: "voice",
      code: "123456",
      callerExternalUserId: "+15550100001",
      assistantId: undefined,
    });
  });

  test("invalid params throw a 400 typed error without calling the engine", async () => {
    let thrown: unknown;
    try {
      // Token path without sourceChannel — shared validation rejects.
      await route("invites_redeem").handler({ token: "raw-token" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MockInviteNativeError);
    expect((thrown as MockInviteNativeError).statusCode).toBe(400);
    expect((thrown as MockInviteNativeError).message).toContain(
      "sourceChannel",
    );
    expect(redeemInviteNativeMock).not.toHaveBeenCalled();
  });

  test("omitted params throw the token-required 400 (no engine call)", async () => {
    await expect(route("invites_redeem").handler(undefined)).rejects.toThrow(
      /token is required/,
    );
    expect(redeemInviteNativeMock).not.toHaveBeenCalled();
  });

  test("propagates an engine failure (e.g. invalid_or_expired)", async () => {
    redeemInviteNativeMock = mock(async () => {
      throw new MockInviteNativeError("invalid_or_expired", 400, "BAD_REQUEST");
    });
    await expect(
      route("invites_redeem").handler({
        code: "000000",
        callerExternalUserId: "+15550100001",
      }),
    ).rejects.toThrow(/invalid_or_expired/);
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

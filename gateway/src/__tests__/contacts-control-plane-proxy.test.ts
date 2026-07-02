import {
  describe,
  test,
  expect,
  mock,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { hashInviteCode, hashInviteToken } from "@vellumai/gateway-client";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

// ── Assistant DB proxy mocks ──────────────────────────────────────────────────
type DbQueryFn = (
  sql: string,
  bind?: unknown[],
) => Promise<Record<string, unknown>[]>;
let assistantDbQueryMock: ReturnType<typeof mock<DbQueryFn>> = mock(
  async () => [],
);

type DbRunFn = (
  sql: string,
  bind?: unknown[],
) => Promise<{ changes: number; lastInsertRowid: number }>;
let assistantDbRunMock: ReturnType<typeof mock<DbRunFn>> = mock(async () => ({
  changes: 1,
  lastInsertRowid: 0,
}));

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: (...args: Parameters<DbQueryFn>) =>
    assistantDbQueryMock(...args),
  assistantDbRun: (...args: Parameters<DbRunFn>) => assistantDbRunMock(...args),
}));

// ── IPC assistant client mock ─────────────────────────────────────────────────
type IpcCallFn = (method: string, params: unknown) => Promise<unknown>;
let ipcCallAssistantMock: ReturnType<typeof mock<IpcCallFn>> = mock(
  async () => ({}),
);

// Spread the actual module so the real IpcHandlerError/IpcTransportError
// classes (and untouched exports like ipcSuggestTrustRule) stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: (...args: Parameters<IpcCallFn>) =>
    ipcCallAssistantMock(...args),
}));

// ── ContactStore mock ─────────────────────────────────────────────────────────
// upsertContact is async and returns a ContactWithInfo shape whose ACL fields
// (role/principalId, channel status/policy) come from the gateway-DB read-back;
// the service layer owns the assistant-DB dual-write internally.
const DEFAULT_MOCK_CONTACT = {
  id: "ct_mock",
  displayName: "Mock Contact",
  notes: null as string | null,
  role: "contact",
  contactType: "human",
  principalId: null as string | null,
  userFile: null as string | null,
  createdAt: 1000000,
  updatedAt: 1000000,
  interactionCount: 0,
  lastInteraction: null as number | null,
  channels: [] as unknown[],
  assistantMetadata: null as Record<string, unknown> | null,
};

type UpsertResult = { contact: typeof DEFAULT_MOCK_CONTACT; created: boolean };
type UpsertFn = (params: unknown) => Promise<UpsertResult>;
let contactStoreUpsertMock: ReturnType<typeof mock<UpsertFn>> = mock(
  async () => ({
    contact: DEFAULT_MOCK_CONTACT,
    created: false,
  }),
);

type ListFn = (opts?: {
  limit?: number;
  role?: string;
}) => Promise<(typeof DEFAULT_MOCK_CONTACT)[]>;
let contactStoreListMock: ReturnType<typeof mock<ListFn>> = mock(
  async () => [],
);

type GetFn = (contactId: string) => Promise<typeof DEFAULT_MOCK_CONTACT | null>;
let contactStoreGetMock: ReturnType<typeof mock<GetFn>> = mock(
  async () => null,
);

// getAclByContactIds returns the gateway ACL source of truth keyed by contact
// id; the overlay path on filtered/search list reads uses it. Default: empty
// map (no ACL to overlay) so the existing forward/passthrough tests are
// unaffected.
type ChannelAcl = {
  id: string;
  type: string;
  address: string;
  status: string | null;
  policy: string | null;
  verifiedAt: number | null;
  verifiedVia: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
};
type ContactAcl = { role: string; channels: Map<string, ChannelAcl> };
type GetAclFn = (ids: string[]) => Promise<Map<string, ContactAcl>>;
let contactStoreGetAclMock: ReturnType<typeof mock<GetAclFn>> = mock(
  async () => new Map<string, ContactAcl>(),
);

type UpdateChannelFn = (
  channelId: string,
  params: {
    status?: string;
    policy?: string;
    reason?: string | null;
  },
) => { id: string; contactId: string; status: string; policy: string } | null;
let contactStoreUpdateChannelMock: ReturnType<typeof mock<UpdateChannelFn>> =
  mock(() => null);

type MergeFn = (
  keepId: string,
  mergeId: string,
) => Promise<typeof DEFAULT_MOCK_CONTACT | null>;
let contactStoreMergeMock: ReturnType<typeof mock<MergeFn>> = mock(
  async () => null,
);

// ── Invite method mocks ───────────────────────────────────────────────────────
type InviteRow = {
  id: string;
  sourceChannel: string;
  inviteCodeHash: string;
  // Secret/display columns are optional here so the legacy list/revoke
  // fixtures stay minimal; the mint echo mock fills them all in.
  tokenHash?: string | null;
  voiceCodeHash?: string | null;
  voiceCodeDigits?: number | null;
  expectedExternalUserId?: string | null;
  friendName?: string | null;
  guardianName?: string | null;
  sourceConversationId?: string | null;
  contactId: string;
  note: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: number;
  status: string;
  createdAt: number;
  updatedAt: number;
};
const DEFAULT_INVITE: InviteRow = {
  id: "inv_1",
  sourceChannel: "telegram",
  inviteCodeHash: "hash_1",
  contactId: "ct_1",
  note: null,
  maxUses: 1,
  useCount: 0,
  // Far-future so the redeem pre-gate's expiry check treats it as still valid.
  expiresAt: 4_000_000_000_000,
  status: "active",
  createdAt: 1000000,
  updatedAt: 1000000,
};

type GetContactFn = (
  contactId: string,
) => { id: string; displayName?: string } | undefined;
let contactStoreGetContactMock: ReturnType<typeof mock<GetContactFn>> = mock(
  () => ({ id: "ct_1" }),
);

type ListInvitesFn = (params: unknown) => InviteRow[];
let contactStoreListInvitesMock: ReturnType<typeof mock<ListInvitesFn>> = mock(
  () => [],
);

type CreateInviteFn = (params: unknown) => InviteRow;
let contactStoreCreateInviteMock: ReturnType<typeof mock<CreateInviteFn>> =
  mock(() => DEFAULT_INVITE);

/**
 * Echo store mock for the native mint: returns a row built from the exact
 * params `createInviteNative` writes, so response/persistence assertions see
 * what the store was actually asked to persist.
 */
function makeEchoCreateInviteMock() {
  return mock((params: unknown): InviteRow => {
    const p = params as Record<string, unknown>;
    return {
      id: p.id as string,
      sourceChannel: p.sourceChannel as string,
      inviteCodeHash: (p.inviteCodeHash as string) ?? "",
      tokenHash: (p.tokenHash as string | null) ?? null,
      voiceCodeHash: (p.voiceCodeHash as string | null) ?? null,
      voiceCodeDigits: (p.voiceCodeDigits as number | null) ?? null,
      expectedExternalUserId:
        (p.expectedExternalUserId as string | null) ?? null,
      friendName: (p.friendName as string | null) ?? null,
      guardianName: (p.guardianName as string | null) ?? null,
      sourceConversationId: (p.sourceConversationId as string | null) ?? null,
      contactId: p.contactId as string,
      note: (p.note as string | null) ?? null,
      maxUses: (p.maxUses as number) ?? 1,
      useCount: 0,
      expiresAt: p.expiresAt as number,
      status: "active",
      createdAt: 1000000,
      updatedAt: 1000000,
    };
  });
}

type RevokeInviteFn = (inviteId: string) => InviteRow | null;
let contactStoreRevokeInviteMock: ReturnType<typeof mock<RevokeInviteFn>> =
  mock(() => DEFAULT_INVITE);

type RecordRedemptionFn = (params: unknown) => { updated: boolean };
let contactStoreRecordRedemptionMock: ReturnType<
  typeof mock<RecordRedemptionFn>
> = mock(() => ({ updated: true }));

type GetInviteByIdFn = (inviteId: string) => InviteRow | null;
let contactStoreGetInviteByIdMock: ReturnType<typeof mock<GetInviteByIdFn>> =
  mock(() => DEFAULT_INVITE);

type MarkInviteExpiredFn = (inviteId: string) => boolean;
let contactStoreMarkInviteExpiredMock: ReturnType<
  typeof mock<MarkInviteExpiredFn>
> = mock(() => true);

mock.module("../db/contact-store.js", () => ({
  NO_INVITE_CODE_HASH: "",
  ContactStore: class MockContactStore {
    upsertContact(...args: Parameters<UpsertFn>) {
      return contactStoreUpsertMock(...args);
    }
    getContact(contactId: string) {
      return contactStoreGetContactMock(contactId);
    }
    listInvites(params: unknown) {
      return contactStoreListInvitesMock(params);
    }
    createInvite(params: unknown) {
      return contactStoreCreateInviteMock(params);
    }
    revokeInvite(inviteId: string) {
      return contactStoreRevokeInviteMock(inviteId);
    }
    recordInviteRedemption(params: unknown) {
      return contactStoreRecordRedemptionMock(params);
    }
    getInviteById(inviteId: string) {
      return contactStoreGetInviteByIdMock(inviteId);
    }
    markInviteExpired(inviteId: string) {
      return contactStoreMarkInviteExpiredMock(inviteId);
    }
    async listContactsWithInfo(opts?: {
      limit?: number;
      role?: string;
      contactType?: string;
    }) {
      return contactStoreListMock(opts);
    }
    async getContactWithInfo(contactId: string) {
      return contactStoreGetMock(contactId);
    }
    async getAclByContactIds(ids: string[]) {
      return contactStoreGetAclMock(ids);
    }
    async updateChannelStatus(
      channelId: string,
      params: {
        status?: string;
        policy?: string;
        reason?: string | null;
      },
    ) {
      return contactStoreUpdateChannelMock(channelId, params);
    }
    async mergeContacts(keepId: string, mergeId: string) {
      return contactStoreMergeMock(keepId, mergeId);
    }
  },
  CannotRevokeBlockedError: class CannotRevokeBlockedError extends Error {
    readonly channelId: string;
    constructor(channelId: string) {
      super(
        "Cannot revoke a blocked channel. Unblock it first or leave it blocked.",
      );
      this.name = "CannotRevokeBlockedError";
      this.channelId = channelId;
    }
  },
  MergeContactsError: class MergeContactsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MergeContactsError";
    }
  },
}));

// ── Redemption engine mock ────────────────────────────────────────────────────
// handleRedeemInvite drives the gateway-native engine directly; mock it so
// these tests pin the handler's dispatch, response shapes, and error mappings
// (engine behavior itself is covered by invite-redemption-engine*.test.ts).
type EngineOutcome = {
  inviteId: string;
  contactId: string;
  sourceChannel: string;
  memberExternalUserId: string;
  result: "redeemed" | "already_member";
};
type EngineResult =
  | {
      status: "redeemed" | "already_member";
      outcome: EngineOutcome;
      replyText: string;
    }
  | { status: "failed"; reason: string; replyText: string }
  | { status: "no_match" };
type RedeemVoiceEngineFn = (params: unknown) => Promise<
  | { status: "redeemed" | "already_member"; outcome: EngineOutcome }
  | { status: "failed"; reason: "invalid_or_expired" }
>;
let redeemVoiceInviteMock: ReturnType<typeof mock<RedeemVoiceEngineFn>> = mock(
  async () => ({ status: "failed", reason: "invalid_or_expired" }),
);
type RedeemTokenEngineFn = (params: unknown) => Promise<EngineResult>;
let redeemInviteByTokenMock: ReturnType<typeof mock<RedeemTokenEngineFn>> =
  mock(async () => ({
    status: "failed",
    reason: "invalid_token",
    replyText: "This invite is no longer valid.",
  }));
mock.module("../verification/invite-redemption.js", () => ({
  redeemVoiceInvite: (...args: Parameters<RedeemVoiceEngineFn>) =>
    redeemVoiceInviteMock(...args),
  redeemInviteByToken: (...args: Parameters<RedeemTokenEngineFn>) =>
    redeemInviteByTokenMock(...args),
  // Faithful stand-in for the real helper (curated contact displayName wins,
  // invite friendName falls back) — the trigger-call tests rely on it.
  resolveInviteeName: (
    store: { getContact: (id: string) => { displayName?: string } | undefined },
    invite: { contactId: string; friendName?: string | null },
    fallback?: string,
  ) =>
    store.getContact(invite.contactId)?.displayName?.trim() ||
    invite.friendName?.trim() ||
    fallback?.trim() ||
    null,
}));

const { createContactsControlPlaneProxyHandler } =
  await import("../http/routes/contacts-control-plane-proxy.js");

// The delete-contact guard reads the guardian role from the gateway DB (source
// of truth), so the delete tests below run against a real in-memory gateway DB.
// ContactStore is fully mocked, so other tests never touch it.
const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contacts: gwContacts } = await import("../db/schema.js");

beforeAll(async () => {
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
  assistantDbQueryMock = mock(async () => []);
  assistantDbRunMock = mock(async () => ({ changes: 1, lastInsertRowid: 0 }));
  ipcCallAssistantMock = mock(async () => ({}));
  contactStoreUpsertMock = mock(async () => ({
    contact: DEFAULT_MOCK_CONTACT,
    created: false,
  }));
  contactStoreListMock = mock(async () => []);
  contactStoreGetMock = mock(async () => null);
  contactStoreGetAclMock = mock(async () => new Map<string, ContactAcl>());
  contactStoreUpdateChannelMock = mock(() => null);
  contactStoreMergeMock = mock(async () => null);
  contactStoreGetContactMock = mock(() => ({ id: "ct_1" }));
  contactStoreListInvitesMock = mock(() => []);
  contactStoreCreateInviteMock = mock(() => DEFAULT_INVITE);
  contactStoreRevokeInviteMock = mock(() => DEFAULT_INVITE);
  contactStoreRecordRedemptionMock = mock(() => ({ updated: true }));
  contactStoreGetInviteByIdMock = mock(() => DEFAULT_INVITE);
  contactStoreMarkInviteExpiredMock = mock(() => true);
  redeemVoiceInviteMock = mock(async () => ({
    status: "failed",
    reason: "invalid_or_expired",
  }));
  redeemInviteByTokenMock = mock(async () => ({
    status: "failed",
    reason: "invalid_token",
    replyText: "This invite is no longer valid.",
  }));
});

describe("contacts control-plane proxy", () => {
  test("forwards contact endpoints to the runtime", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());

    // Use ?query= to force proxy fallback (list is now gateway-native for
    // non-search queries).
    await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?limit=10&query=alice"),
    );
    // GetContact falls back to proxy when the store throws; seed a throw.
    contactStoreGetMock = mock(async () => {
      throw new Error("force proxy fallback");
    });
    await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/ct_1"),
      "ct_1",
    );

    expect(captured).toEqual([
      "http://localhost:7821/v1/contacts?limit=10&query=alice",
      "http://localhost:7821/v1/contacts/ct_1",
    ]);
  });

  test("invite handlers never proxy to the runtime", async () => {
    // All five invite handlers are gateway-native; none should call fetch.
    const handler = createContactsControlPlaneProxyHandler(makeConfig());

    await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites?status=active"),
    );
    await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "telegram" }),
      }),
    );
    await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "tok", sourceChannel: "telegram" }),
      }),
    );
    await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_123", {
        method: "DELETE",
      }),
      "inv_123",
    );
    await handler.handleCallInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_123/call", {
        method: "POST",
      }),
      "inv_123",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 502 when runtime is unreachable", async () => {
    fetchMock = mock(async () => {
      throw new Error("Connection refused");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    // Use ?query= to force proxy fallback path (list is gateway-native otherwise).
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=test"),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway" });
  });

  test("passes through successful response body", async () => {
    const responsePayload = {
      contacts: [{ id: "ct_1", name: "Alice" }],
      total: 1,
    };
    fetchMock = mock(async () => {
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=test"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responsePayload);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  test("strips hop-by-hop headers from upstream response", async () => {
    fetchMock = mock(async () => {
      return new Response("ok", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "x-custom": "preserved",
        },
      });
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=test"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.has("connection")).toBe(false);
    expect(res.headers.has("keep-alive")).toBe(false);
    expect(res.headers.get("x-custom")).toBe("preserved");
  });
});

describe("handleUpsertContact (gateway-native)", () => {
  test("returns 400 when displayName is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactType: "human" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/displayName/);
  });

  test("returns 400 for invalid contactType", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Alice", contactType: "robot" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/contactType/);
  });

  test("creates contact natively and returns contact shape", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_abc123",
      displayName: "Alice",
    };
    contactStoreUpsertMock = mock(async () => ({
      contact: mockContact,
      created: true,
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Alice" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_abc123");
    expect(body.contact.displayName).toBe("Alice");
    expect(body.contact.channels).toEqual([]);
    // Service layer owns the upsert + dual-write.
    expect(contactStoreUpsertMock).toHaveBeenCalledTimes(1);
    const [params] = contactStoreUpsertMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(params.displayName).toBe("Alice");
  });

  test("strips role and principalId from request body (privilege escalation guard)", async () => {
    // Regression: a malicious caller MUST NOT be able to rebind the guardian
    // by sending `role: "guardian"` + their own principalId via POST
    // /v1/contacts. The route handler must never pass those fields through
    // to the service layer; ContactStore's params surface must not include
    // them.
    contactStoreUpsertMock = mock(async () => ({
      contact: { ...DEFAULT_MOCK_CONTACT, id: "ct_target", role: "guardian" },
      created: false,
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "ct_target",
          displayName: "Pwn3d",
          role: "guardian",
          principalId: "attacker-principal-id",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(contactStoreUpsertMock).toHaveBeenCalledTimes(1);
    const [params] = contactStoreUpsertMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(params.role).toBeUndefined();
    expect(params.principalId).toBeUndefined();
    // The other fields still flow through.
    expect(params.id).toBe("ct_target");
    expect(params.displayName).toBe("Pwn3d");
  });

  test("returns 400 when body is invalid JSON", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 400 when channel.type is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Alice",
          channels: [{ address: "alice@example.com" }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/channel\.type/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("returns 400 when channel.address is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Alice",
          channels: [{ type: "email" }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/channel\.address/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("returns 400 when channel.address is empty/whitespace", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Alice",
          channels: [{ type: "email", address: "   " }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/channel\.address/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("rejects unsupported species (e.g. openclaw)", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Some Bot",
          contactType: "assistant",
          assistantMetadata: { species: "openclaw", metadata: {} },
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/species/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("rejects vellum metadata missing assistantId", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Vellum Bot",
          contactType: "assistant",
          assistantMetadata: {
            species: "vellum",
            metadata: { gatewayUrl: "https://x.example" },
          },
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/assistantId/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("rejects vellum metadata missing gatewayUrl", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Vellum Bot",
          contactType: "assistant",
          assistantMetadata: {
            species: "vellum",
            metadata: { assistantId: "asst_123" },
          },
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/gatewayUrl/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("accepts vellum assistant with full metadata", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Vellum Bot",
          contactType: "assistant",
          assistantMetadata: {
            species: "vellum",
            metadata: {
              assistantId: "asst_123",
              gatewayUrl: "https://gw.example.com",
            },
          },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(contactStoreUpsertMock).toHaveBeenCalledTimes(1);
    const [params] = contactStoreUpsertMock.mock.calls[0] as [
      {
        assistantMetadata?: {
          species: string;
          metadata?: Record<string, unknown>;
        };
      },
    ];
    expect(params.assistantMetadata?.species).toBe("vellum");
    expect(params.assistantMetadata?.metadata?.assistantId).toBe("asst_123");
  });
});

describe("handleListContacts (gateway-native)", () => {
  test("returns contacts from gateway-native read", async () => {
    const mockContacts = [
      { ...DEFAULT_MOCK_CONTACT, id: "c1", displayName: "Alice" },
      { ...DEFAULT_MOCK_CONTACT, id: "c2", displayName: "Bob" },
    ];
    contactStoreListMock = mock(async () => mockContacts);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contacts).toHaveLength(2);
    expect(body.contacts[0].id).toBe("c1");
    expect(body.contacts[0].displayName).toBe("Alice");
    // Compat: externalUserId = address on each channel.
    // (DEFAULT_MOCK_CONTACT has empty channels, so this is vacuous here.)
    expect(contactStoreListMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falls back to proxy for contactType filter (assistant-owned field)", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?contactType=human"),
    );

    expect(contactStoreListMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to proxy for search-style queries (query param)", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );

    expect(contactStoreListMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to proxy for channelAddress search", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    await handler.handleListContacts(
      new Request(
        "http://localhost:7830/v1/contacts?channelAddress=alice@example.com",
      ),
    );

    expect(contactStoreListMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns 400 for invalid contactType", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?contactType=robot"),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/contactType/);
    expect(contactStoreListMock).not.toHaveBeenCalled();
  });

  test("falls back to proxy on gateway-native read error", async () => {
    contactStoreListMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test("includes externalUserId compat field on channels", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      channels: [
        {
          id: "ch1",
          contactId: "c1",
          type: "telegram",
          address: "@alice",
          isPrimary: true,
          externalChatId: "12345",
          status: "active",
          policy: "allow",
          verifiedAt: null,
          verifiedVia: null,
          inviteId: null,
          revokedReason: null,
          blockedReason: null,
          lastSeenAt: null,
          interactionCount: 0,
          lastInteraction: null,
          createdAt: 100,
          updatedAt: null,
        },
      ],
    };
    contactStoreListMock = mock(async () => [mockContact]);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
    );

    const body = await res.json();
    expect(body.contacts[0].channels[0].externalUserId).toBe("@alice");
  });
});

describe("handleListContacts ACL overlay (filtered/search path)", () => {
  // A daemon contact as it comes back from the search path: neutral role,
  // channels with unverified ACL. The overlay must replace role + channel ACL
  // from the gateway DB while leaving info/identity fields untouched.
  function daemonContact(overrides: Record<string, unknown> = {}) {
    return {
      id: "c1",
      displayName: "Alice",
      role: "contact",
      notes: "friend from college",
      contactType: "human",
      interactionCount: 7,
      lastInteraction: 555,
      createdAt: 100,
      updatedAt: 200,
      channels: [
        {
          id: "ch1",
          contactId: "c1",
          type: "telegram",
          address: "@alice",
          isPrimary: true,
          externalUserId: "@alice",
          externalChatId: "12345",
          inviteId: null,
          status: "unverified",
          policy: "allow",
          verifiedAt: null,
          verifiedVia: null,
          revokedReason: null,
          blockedReason: null,
          lastSeenAt: null,
          interactionCount: 3,
          lastInteraction: 555,
          createdAt: 100,
          updatedAt: 200,
        },
      ],
      ...overrides,
    };
  }

  function daemonResponse(contacts: unknown[]) {
    return new Response(JSON.stringify({ ok: true, contacts }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  test("overlays gateway role + channel ACL onto a filtered query", async () => {
    fetchMock = mock(async () => daemonResponse([daemonContact()]));
    contactStoreGetAclMock = mock(
      async () =>
        new Map<string, ContactAcl>([
          [
            "c1",
            {
              role: "guardian",
              channels: new Map<string, ChannelAcl>([
                [
                  "ch1",
                  {
                    id: "ch1",
                    type: "telegram",
                    address: "@alice",
                    status: "active",
                    policy: "escalate",
                    verifiedAt: 9999,
                    verifiedVia: "manual",
                    revokedReason: null,
                    blockedReason: null,
                  },
                ],
              ]),
            },
          ],
        ]),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts[0].role).toBe("guardian");
    const ch = body.contacts[0].channels[0];
    expect(ch.status).toBe("active");
    expect(ch.policy).toBe("escalate");
    expect(ch.verifiedAt).toBe(9999);
    expect(ch.verifiedVia).toBe("manual");
    expect(contactStoreGetAclMock).toHaveBeenCalledTimes(1);
    expect(contactStoreGetAclMock.mock.calls[0][0]).toEqual(["c1"]);
  });

  test("channel matched by id: ACL replaced, info/identity preserved exactly", async () => {
    fetchMock = mock(async () => daemonResponse([daemonContact()]));
    contactStoreGetAclMock = mock(
      async () =>
        new Map<string, ContactAcl>([
          [
            "c1",
            {
              role: "guardian",
              channels: new Map<string, ChannelAcl>([
                [
                  "ch1",
                  {
                    id: "ch1",
                    type: "telegram",
                    address: "@alice",
                    status: "active",
                    policy: "deny",
                    verifiedAt: 1234,
                    verifiedVia: "challenge",
                    revokedReason: null,
                    blockedReason: null,
                  },
                ],
              ]),
            },
          ],
        ]),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );
    const body = await res.json();
    const contact = body.contacts[0];
    const ch = contact.channels[0];

    // ACL replaced.
    expect(ch.status).toBe("active");
    expect(ch.policy).toBe("deny");
    expect(ch.verifiedVia).toBe("challenge");
    // Info/identity preserved.
    expect(contact.displayName).toBe("Alice");
    expect(contact.notes).toBe("friend from college");
    expect(contact.contactType).toBe("human");
    expect(contact.interactionCount).toBe(7);
    expect(ch.address).toBe("@alice");
    expect(ch.externalUserId).toBe("@alice");
    expect(ch.externalChatId).toBe("12345");
    expect(ch.isPrimary).toBe(true);
    expect(ch.interactionCount).toBe(3);
  });

  test("channel matched by (type,address) when ids differ", async () => {
    // Daemon channel id differs from the gateway's; fall back to (type,address).
    fetchMock = mock(async () =>
      daemonResponse([
        daemonContact({
          channels: [
            {
              ...daemonContact().channels[0],
              id: "daemon-side-id",
            },
          ],
        }),
      ]),
    );
    contactStoreGetAclMock = mock(
      async () =>
        new Map<string, ContactAcl>([
          [
            "c1",
            {
              role: "contact",
              channels: new Map<string, ChannelAcl>([
                [
                  "gateway-side-id",
                  {
                    id: "gateway-side-id",
                    type: "telegram",
                    address: "@alice",
                    status: "active",
                    policy: "allow",
                    verifiedAt: 42,
                    verifiedVia: "manual",
                    revokedReason: null,
                    blockedReason: null,
                  },
                ],
              ]),
            },
          ],
        ]),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );
    const body = await res.json();
    const ch = body.contacts[0].channels[0];
    expect(ch.status).toBe("active");
    expect(ch.verifiedAt).toBe(42);
    // The daemon channel id is preserved (we only overlay ACL fields).
    expect(ch.id).toBe("daemon-side-id");
  });

  test("(type,address) fallback is case-insensitive on address", async () => {
    // Daemon and gateway disagree on channel id AND address casing. The
    // logical key is (type, lower(address)), so the overlay must still match.
    fetchMock = mock(async () =>
      daemonResponse([
        daemonContact({
          channels: [
            {
              ...daemonContact().channels[0],
              id: "daemon-side-id",
              type: "email",
              address: "Alice@Example.COM",
            },
          ],
        }),
      ]),
    );
    contactStoreGetAclMock = mock(
      async () =>
        new Map<string, ContactAcl>([
          [
            "c1",
            {
              role: "contact",
              channels: new Map<string, ChannelAcl>([
                [
                  "gateway-side-id",
                  {
                    id: "gateway-side-id",
                    type: "email",
                    address: "alice@example.com",
                    status: "blocked",
                    policy: "deny",
                    verifiedAt: null,
                    verifiedVia: null,
                    revokedReason: null,
                    blockedReason: "spam",
                  },
                ],
              ]),
            },
          ],
        ]),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );
    const ch = (await res.json()).contacts[0].channels[0];
    // Matched despite case + id mismatch: blocked ACL overlaid, not neutral.
    expect(ch.status).toBe("blocked");
    expect(ch.blockedReason).toBe("spam");
  });

  test("soft-fail: ACL read throws → original daemon response unchanged", async () => {
    const original = { ok: true, contacts: [daemonContact()] };
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify(original), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    contactStoreGetAclMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Unchanged: neutral role + unverified channel, exactly as the daemon sent.
    expect(body).toEqual(original);
    expect(body.contacts[0].role).toBe("contact");
    expect(body.contacts[0].channels[0].status).toBe("unverified");
  });

  test("dual-write gap: present contact overlaid, missing one keeps daemon ACL; neither dropped", async () => {
    const c2 = daemonContact({
      id: "c2",
      displayName: "Bob",
      channels: [
        {
          ...daemonContact().channels[0],
          id: "ch2",
          contactId: "c2",
          address: "@bob",
        },
      ],
    });
    fetchMock = mock(async () => daemonResponse([daemonContact(), c2]));
    // Only c1 is in the gateway ACL map; c2 is the dual-write-gap survivor.
    contactStoreGetAclMock = mock(
      async () =>
        new Map<string, ContactAcl>([
          [
            "c1",
            {
              role: "guardian",
              channels: new Map<string, ChannelAcl>([
                [
                  "ch1",
                  {
                    id: "ch1",
                    type: "telegram",
                    address: "@alice",
                    status: "active",
                    policy: "allow",
                    verifiedAt: 1,
                    verifiedVia: "manual",
                    revokedReason: null,
                    blockedReason: null,
                  },
                ],
              ]),
            },
          ],
        ]),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=team"),
    );
    const body = await res.json();

    // Neither contact dropped.
    expect(body.contacts).toHaveLength(2);
    // c1 overlaid.
    const c1 = body.contacts.find((c: { id: string }) => c.id === "c1");
    expect(c1.role).toBe("guardian");
    expect(c1.channels[0].status).toBe("active");
    // c2 keeps the daemon ACL (neutral).
    const bob = body.contacts.find((c: { id: string }) => c.id === "c2");
    expect(bob.role).toBe("contact");
    expect(bob.channels[0].status).toBe("unverified");
  });

  test("regression guard: no-filter request stays gateway-native (no daemon forward)", async () => {
    contactStoreListMock = mock(async () => [
      { ...DEFAULT_MOCK_CONTACT, id: "c1", displayName: "Alice" },
    ]);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
    );

    expect(res.status).toBe(200);
    // Native path: daemon forward and ACL overlay are NOT used.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(contactStoreGetAclMock).not.toHaveBeenCalled();
    expect(contactStoreListMock).toHaveBeenCalledTimes(1);
  });

  test("soft-fail: non-2xx daemon status returned unchanged", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );

    expect(res.status).toBe(500);
    expect(contactStoreGetAclMock).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: "boom" });
  });

  test("drops stale content-length so the resized overlaid body isn't truncated", async () => {
    // Daemon sends a content-length matching its NEUTRAL body. The overlay
    // grows the body (role + ACL fields), so reusing that length would
    // truncate the response. We must drop it and let the runtime recompute.
    const neutralBody = JSON.stringify({
      ok: true,
      contacts: [daemonContact()],
    });
    fetchMock = mock(
      async () =>
        new Response(neutralBody, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(neutralBody)),
          },
        }),
    );
    contactStoreGetAclMock = mock(
      async () =>
        new Map<string, ContactAcl>([
          [
            "c1",
            {
              role: "guardian",
              channels: new Map<string, ChannelAcl>([
                [
                  "ch1",
                  {
                    id: "ch1",
                    type: "telegram",
                    address: "@alice",
                    status: "active",
                    policy: "escalate",
                    verifiedAt: 9999,
                    verifiedVia: "manual",
                    revokedReason: null,
                    blockedReason: null,
                  },
                ],
              ]),
            },
          ],
        ]),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );

    // Stale content-length dropped; body fully intact (not truncated).
    expect(res.headers.get("content-length")).toBeNull();
    const body = await res.json();
    expect(body.contacts[0].role).toBe("guardian");
    expect(body.contacts[0].channels[0].verifiedVia).toBe("manual");
  });
});

describe("handleGetContact (gateway-native)", () => {
  test("returns contact from gateway-native read", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      displayName: "Alice",
    };
    contactStoreGetMock = mock(async () => mockContact);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("c1");
    expect(body.contact.displayName).toBe("Alice");
    expect(contactStoreGetMock).toHaveBeenCalledWith("c1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 404 when contact not found", async () => {
    contactStoreGetMock = mock(async () => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/nope"),
      "nope",
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("includes assistantMetadata with contactId for assistant contactType", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      contactType: "assistant",
      assistantMetadata: {
        species: "vellum",
        metadata: { assistantId: "asst_1" },
      },
    };
    contactStoreGetMock = mock(async () => mockContact);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    const body = await res.json();
    expect(body.assistantMetadata).toEqual({
      contactId: "c1",
      species: "vellum",
      metadata: { assistantId: "asst_1" },
    });
  });

  test("omits assistantMetadata for human contactType", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      contactType: "human",
      assistantMetadata: null,
    };
    contactStoreGetMock = mock(async () => mockContact);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    const body = await res.json();
    expect(body.assistantMetadata).toBeUndefined();
  });

  test("falls back to proxy on gateway-native read error", async () => {
    contactStoreGetMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });
    fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ ok: true, contact: DEFAULT_MOCK_CONTACT }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe("handleUpdateContactChannel (gateway-native)", () => {
  const MOCK_CHANNEL = {
    id: "ch_1",
    contactId: "ct_mock",
    status: "active",
    policy: "allow",
  };

  test("updates channel status natively and returns parent contact", async () => {
    contactStoreUpdateChannelMock = mock(() => ({
      ...MOCK_CHANNEL,
      status: "revoked",
    }));
    contactStoreGetMock = mock(async () => ({
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_mock",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked", reason: "user request" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_mock");
    expect(contactStoreUpdateChannelMock).toHaveBeenCalledTimes(1);
    const [channelId, params] = contactStoreUpdateChannelMock.mock.calls[0] as [
      string,
      { status?: string; reason?: string },
    ];
    expect(channelId).toBe("ch_1");
    expect(params.status).toBe("revoked");
    expect(params.reason).toBe("user request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("updates channel policy natively", async () => {
    contactStoreUpdateChannelMock = mock(() => ({
      ...MOCK_CHANNEL,
      policy: "deny",
    }));
    contactStoreGetMock = mock(async () => DEFAULT_MOCK_CONTACT);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: "deny" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(200);
    expect(contactStoreUpdateChannelMock).toHaveBeenCalledTimes(1);
  });

  test("returns 400 for invalid status", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "deleted" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/status/);
    expect(contactStoreUpdateChannelMock).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid policy", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: "maybe" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/policy/);
  });

  test("returns 400 when neither status nor policy provided", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "no status or policy" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/status or policy/);
  });

  test("returns 400 for invalid JSON body", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 404 when channel not found", async () => {
    contactStoreUpdateChannelMock = mock(() => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "nope",
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 409 when revoking a blocked channel", async () => {
    const { CannotRevokeBlockedError } = await import("../db/contact-store.js");
    contactStoreUpdateChannelMock = mock(() => {
      throw new CannotRevokeBlockedError("ch_1");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 500 on unexpected gateway error (no proxy fallback)", async () => {
    contactStoreUpdateChannelMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("resolves assistant-side channel ID to gateway channel (backward compat)", async () => {
    // Simulate: store.updateChannelStatus gets an assistant-side ID that
    // doesn't exist in the gateway DB. The real method resolves it via
    // assistantDbQuery. Here we mock the store to return the resolved
    // channel, confirming the handler correctly awaits the async call
    // and returns 200 (not 404).
    contactStoreUpdateChannelMock = mock(() => ({
      ...MOCK_CHANNEL,
      status: "revoked",
    }));
    contactStoreGetMock = mock(async () => ({
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_mock",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/asst-side-id", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "asst-side-id",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_mock");
  });
});
describe("handleMergeContacts (gateway-native)", () => {
  test("merges contacts natively and returns survivor", async () => {
    contactStoreMergeMock = mock(async () => ({
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_keep",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_merge" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_keep");
    expect(contactStoreMergeMock).toHaveBeenCalledTimes(1);
    expect(contactStoreMergeMock.mock.calls[0][0]).toBe("ct_keep");
    expect(contactStoreMergeMock.mock.calls[0][1]).toBe("ct_merge");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 when keepId is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mergeId: "ct_merge" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/keepId and mergeId/);
    expect(contactStoreMergeMock).not.toHaveBeenCalled();
  });

  test("returns 400 when mergeId is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(contactStoreMergeMock).not.toHaveBeenCalled();
  });

  test("returns 400 for self-merge", async () => {
    const { MergeContactsError } = await import("../db/contact-store.js");
    contactStoreMergeMock = mock(async () => {
      throw new MergeContactsError("Cannot merge a contact with itself");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_1", mergeId: "ct_1" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/self/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 when contact not found", async () => {
    const { MergeContactsError } = await import("../db/contact-store.js");
    contactStoreMergeMock = mock(async () => {
      throw new MergeContactsError('Contact "ct_x" not found');
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_x" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/not found/);
  });

  test("returns 400 for invalid JSON body", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 500 on unexpected error (no proxy fallback)", async () => {
    contactStoreMergeMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_merge" }),
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 200 even if store returns null (survivor read-back miss)", async () => {
    contactStoreMergeMock = mock(async () => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_merge" }),
      }),
    );

    // The merge itself succeeded (no throw); the survivor read-back just
    // returned null. Still 200 with ok:true.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact).toBeUndefined();
  });
});

test("returns 400 when merging away a guardian contact", async () => {
  const { MergeContactsError } = await import("../db/contact-store.js");
  contactStoreMergeMock = mock(async () => {
    throw new MergeContactsError(
      "Cannot merge away a guardian contact. Keep the guardian as the survivor instead.",
    );
  });

  const handler = createContactsControlPlaneProxyHandler(makeConfig());
  const res = await handler.handleMergeContacts(
    new Request("http://localhost:7830/v1/contacts/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepId: "ct_regular", mergeId: "ct_guardian" }),
    }),
  );

  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("BAD_REQUEST");
  expect(body.error.message).toMatch(/guardian/);
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("handleDeleteContact (gateway-native)", () => {
  function seedGatewayContact(id: string, role: "guardian" | "contact") {
    const now = Date.now();
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id,
        displayName: `name-${id}`,
        role,
        principalId: role === "guardian" ? `prin-${id}` : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  afterEach(() => {
    getGatewayDb().delete(gwContacts).run();
  });

  test("rejects deleting a guardian whose role lives only in the gateway DB", async () => {
    seedGatewayContact("ct_guardian", "guardian");
    // The assistant row is missing/defaulted (dual-write gap): the guard must
    // not fall back to the assistant role, which would default to contact.
    assistantDbQueryMock = mock(async () => []);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleDeleteContact("ct_guardian");

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    // Neither DB was deleted from.
    expect(assistantDbRunMock).not.toHaveBeenCalled();
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
  });

  test("deletes a non-guardian contact from both DBs", async () => {
    seedGatewayContact("ct_regular", "contact");

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleDeleteContact("ct_regular");

    expect(res.status).toBe(204);
    const deleteCalls = ipcCallAssistantMock.mock.calls.filter(
      (c) => c[0] === "contacts_mirror_delete_contact",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]![1]).toEqual({ body: { contactId: "ct_regular" } });
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });

  test("deletes an assistant-mirror-only orphan the gateway DB never recorded", async () => {
    // No gateway row (a dual-write gap on inbound seeding), but the assistant
    // mirror holds the contact — the list can surface it, so delete must clean
    // it up instead of 404ing and leaving it stuck in the UI.
    assistantDbQueryMock = mock(async () => [{ id: "ct_orphan" }]);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleDeleteContact("ct_orphan");

    expect(res.status).toBe(204);
    // The mirror delete ran; the gateway delete is a harmless no-op.
    expect(
      ipcCallAssistantMock.mock.calls.some(
        (c) => c[0] === "contacts_mirror_delete_contact",
      ),
    ).toBe(true);
  });

  test("returns 404 only when the contact is absent from both DBs", async () => {
    // Absent from the gateway DB (not seeded) and from the assistant mirror.
    assistantDbQueryMock = mock(async () => []);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleDeleteContact("ct_missing");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(assistantDbRunMock).not.toHaveBeenCalled();
  });

  test("still deletes a gateway contact when the assistant mirror is unavailable", async () => {
    seedGatewayContact("ct_mirror_down", "contact");
    // The mirror lookup AND delete both throw (assistant DB unavailable). The
    // delete must degrade to gateway-only rather than 500ing on the mirror.
    assistantDbQueryMock = mock(async () => {
      throw new Error("assistant DB unavailable");
    });
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "contacts_mirror_delete_contact") {
        throw new Error("assistant mirror unavailable");
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleDeleteContact("ct_mirror_down");

    expect(res.status).toBe(204);
    // The source-of-truth gateway row was still deleted despite the mirror
    // outage.
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });
});

describe("handleCreateInvite (gateway-native mint)", () => {
  test("rejects sourceChannel 'a2a' (A2A invites are daemon-managed)", async () => {
    contactStoreCreateInviteMock = makeEchoCreateInviteMock();

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "a2a" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(contactStoreCreateInviteMock).toHaveBeenCalledTimes(0);
  });

  test("mints token + 6-digit code natively for non-voice invites; only hashes reach the store", async () => {
    contactStoreCreateInviteMock = makeEchoCreateInviteMock();

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: "ct_1",
          sourceChannel: "telegram",
          note: "For Alice",
          maxUses: 3,
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // One-time plaintext secrets are returned exactly once.
    expect(typeof body.rawToken).toBe("string");
    expect(body.invite.token).toBe(body.rawToken);
    expect(/^\d{6}$/.test(body.invite.inviteCode)).toBe(true);
    expect(body.invite.voiceCode).toBeUndefined();
    expect(body.invite.note).toBe("For Alice");
    expect(body.invite.maxUses).toBe(3);
    expect(body.invite.status).toBe("active");

    // Exactly one gateway row write; only hashes persist — never plaintext.
    expect(contactStoreCreateInviteMock).toHaveBeenCalledTimes(1);
    const [createParams] = contactStoreCreateInviteMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(createParams.tokenHash).toBe(hashInviteToken(body.rawToken));
    expect(createParams.inviteCodeHash).toBe(
      hashInviteCode(body.invite.inviteCode),
    );
    expect(createParams.voiceCodeHash).toBeNull();
    expect(Object.values(createParams)).not.toContain(body.rawToken);
    expect(Object.values(createParams)).not.toContain(body.invite.inviteCode);

    // Brute-forceable hashes never reach the response.
    expect(body.invite.inviteCodeHash).toBeUndefined();
    expect(body.invite.voiceCodeHash).toBeUndefined();
    // tokenHash is response-shape compatible (256-bit preimage, not guessable).
    expect(body.invite.tokenHash).toBe(createParams.tokenHash);

    // No assistant mint relay — only the contacts_changed notification.
    const ipcMethods = ipcCallAssistantMock.mock.calls.map((c) => c[0]);
    expect(ipcMethods).not.toContain("invites_mint");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("layers daemon-composed presentation fields onto the HTTP create response", async () => {
    contactStoreCreateInviteMock = makeEchoCreateInviteMock();
    ipcCallAssistantMock = mock(
      async (method: string, params: unknown): Promise<unknown> => {
        if (method !== "invites_compose_presentation") return {};
        const { invite } = (
          params as { body: { invite: Record<string, unknown> } }
        ).body;
        return {
          invite: {
            ...invite,
            share: {
              url: "https://t.me/example_bot?start=tok",
              displayText: "Join on Telegram",
            },
            guardianInstruction: "Send the link to your friend.",
            channelHandle: "@example_bot",
          },
        };
      },
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "telegram" }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Presentation fields reach direct gateway HTTP callers.
    expect(body.invite.share.url).toBe("https://t.me/example_bot?start=tok");
    expect(body.invite.guardianInstruction).toBe(
      "Send the link to your friend.",
    );
    expect(body.invite.channelHandle).toBe("@example_bot");
    // Composition merges onto (not replaces) the one-time minted payload.
    expect(body.invite.token).toBe(body.rawToken);
    expect(/^\d{6}$/.test(body.invite.inviteCode)).toBe(true);

    // Exactly one composition, carrying the mint result the daemon needs.
    const composeCalls = ipcCallAssistantMock.mock.calls.filter(
      (c) => c[0] === "invites_compose_presentation",
    );
    expect(composeCalls).toHaveLength(1);
    const composeBody = (
      composeCalls[0][1] as {
        body: { contactId?: string; rawToken?: string };
      }
    ).body;
    expect(composeBody.contactId).toBe("ct_1");
    expect(composeBody.rawToken).toBe(body.rawToken);
  });

  test("returns the raw minted payload when the daemon presentation IPC fails", async () => {
    contactStoreCreateInviteMock = makeEchoCreateInviteMock();
    ipcCallAssistantMock = mock(async (method: string): Promise<unknown> => {
      if (method === "invites_compose_presentation") {
        throw new Error("daemon unreachable");
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "telegram" }),
      }),
    );

    // Presentation is best-effort UX; the create itself must still succeed
    // with the one-time secrets.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.rawToken).toBe("string");
    expect(body.invite.token).toBe(body.rawToken);
    expect(body.invite.share).toBeUndefined();
    expect(body.invite.guardianInstruction).toBeUndefined();
    expect(body.invite.channelHandle).toBeUndefined();
  });

  test("mints an identity-bound voiceCode for phone invites — no token, passthrough fields stored", async () => {
    contactStoreGetContactMock = mock(() => ({
      id: "ct_1",
      displayName: "Sam Example",
    }));
    contactStoreCreateInviteMock = makeEchoCreateInviteMock();

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: "ct_1",
          sourceChannel: "phone",
          expectedExternalUserId: "+15551234567",
          guardianName: "Guardian Example",
          sourceConversationId: "conv-9",
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();

    // Voice invites never expose a token; the spoken code is the credential.
    expect(body.rawToken).toBeUndefined();
    expect(body.invite.token).toBeUndefined();
    expect(body.invite.tokenHash).toBeUndefined();
    expect(/^\d{6}$/.test(body.invite.voiceCode)).toBe(true);
    expect(body.invite.voiceCodeDigits).toBe(6);
    expect(body.invite.expectedExternalUserId).toBe("+15551234567");
    // friendName resolves from the gateway contact's displayName.
    expect(body.invite.friendName).toBe("Sam Example");
    // guardianName is a stored passthrough (daemon-supplied, never interpreted).
    expect(body.invite.guardianName).toBe("Guardian Example");

    const [createParams] = contactStoreCreateInviteMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(createParams.voiceCodeHash).toBe(
      hashInviteCode(body.invite.voiceCode),
    );
    expect(createParams.tokenHash).toBeNull();
    // No 6-digit channel code for voice — the sentinel keeps NOT NULL happy.
    expect(createParams.inviteCodeHash).toBe("");
    expect(createParams.guardianName).toBe("Guardian Example");
    expect(createParams.sourceConversationId).toBe("conv-9");
    expect(Object.values(createParams)).not.toContain(body.invite.voiceCode);
  });

  test("returns 400 when expectedExternalUserId is missing for phone invites", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "phone" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/expectedExternalUserId/);
    expect(contactStoreCreateInviteMock).not.toHaveBeenCalled();
  });

  test("returns 400 for a non-E.164 expectedExternalUserId", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: "ct_1",
          sourceChannel: "phone",
          expectedExternalUserId: "not-a-phone-number",
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/E\.164/);
    expect(contactStoreCreateInviteMock).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid JSON body", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
    expect(contactStoreCreateInviteMock).not.toHaveBeenCalled();
  });

  test("returns 400 when sourceChannel is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/sourceChannel/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 404 when contact does not exist", async () => {
    contactStoreGetContactMock = mock(() => undefined);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: "ct_missing",
          sourceChannel: "telegram",
        }),
      }),
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    expect(contactStoreCreateInviteMock).not.toHaveBeenCalled();
  });

  test("returns 500 when gateway DB write fails (no proxy fallback)", async () => {
    contactStoreCreateInviteMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "telegram" }),
      }),
    );

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleListInvites (gateway-native)", () => {
  test("returns voice/display fields from the gateway row; assistant DB never queried", async () => {
    contactStoreListInvitesMock = mock(() => [
      {
        ...DEFAULT_INVITE,
        id: "inv_1",
        sourceChannel: "phone",
        voiceCodeDigits: 6,
        friendName: "Alice",
        guardianName: "Bob",
        expectedExternalUserId: "+15551234567",
      },
    ]);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites?status=active"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].id).toBe("inv_1");
    expect(body.invites[0].voiceCodeDigits).toBe(6);
    expect(body.invites[0].friendName).toBe("Alice");
    expect(body.invites[0].guardianName).toBe("Bob");
    expect(body.invites[0].expectedExternalUserId).toBe("+15551234567");
    // The brute-forceable code hash must never be exposed in list responses.
    expect(body.invites[0]).not.toHaveProperty("inviteCodeHash");
    // status filter passed through to the store query.
    expect(contactStoreListInvitesMock.mock.calls[0][0]).toEqual({
      status: "active",
    });
    // The gateway DB is the single source: no assistant DB access, no proxy.
    expect(assistantDbQueryMock).not.toHaveBeenCalled();
    expect(assistantDbRunMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("strips tokenHash and voiceCodeHash (not just inviteCodeHash) from list responses", async () => {
    contactStoreListInvitesMock = mock(() => [
      {
        ...DEFAULT_INVITE,
        id: "inv_1",
        sourceChannel: "phone",
        tokenHash: "secret-token-hash",
        voiceCodeHash: "secret-voice-hash",
      },
    ]);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].id).toBe("inv_1");
    // No secret hash field may ever reach the wire.
    expect(body.invites[0]).not.toHaveProperty("inviteCodeHash");
    expect(body.invites[0]).not.toHaveProperty("tokenHash");
    expect(body.invites[0]).not.toHaveProperty("voiceCodeHash");
  });

  test("succeeds even when the assistant DB is unavailable (list never touches it)", async () => {
    contactStoreListInvitesMock = mock(() => [
      { ...DEFAULT_INVITE, id: "inv_1" },
    ]);
    assistantDbQueryMock = mock(async () => {
      throw new Error("assistant DB down");
    });
    assistantDbRunMock = mock(async () => {
      throw new Error("assistant DB down");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].id).toBe("inv_1");
    expect(body.invites[0]).not.toHaveProperty("inviteCodeHash");
    expect(assistantDbQueryMock).not.toHaveBeenCalled();
    expect(assistantDbRunMock).not.toHaveBeenCalled();
  });

  test("returns 500 when the gateway read throws", async () => {
    contactStoreListInvitesMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites"),
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleRevokeInvite (gateway-native)", () => {
  test("revokes the invite via a single gateway UPDATE; assistant DB never touched", async () => {
    contactStoreRevokeInviteMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "revoked",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1", {
        method: "DELETE",
      }),
      "inv_1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invite.status).toBe("revoked");
    // Revoke responses must not leak the brute-forceable code hash.
    expect(body.invite).not.toHaveProperty("inviteCodeHash");
    expect(contactStoreRevokeInviteMock).toHaveBeenCalledWith("inv_1");
    // The gateway DB is the single source: no assistant DB access, no proxy.
    expect(assistantDbRunMock).not.toHaveBeenCalled();
    expect(assistantDbQueryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("revokes a backfilled (pre-migration) invite carrying voice/display fields", async () => {
    contactStoreRevokeInviteMock = mock(() => ({
      ...DEFAULT_INVITE,
      id: "inv_backfilled",
      sourceChannel: "phone",
      status: "revoked",
      tokenHash: "secret-token-hash",
      voiceCodeHash: "secret-voice-hash",
      voiceCodeDigits: 6,
      friendName: "Alice",
      guardianName: "Bob",
      expectedExternalUserId: "+15551234567",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_backfilled", {
        method: "DELETE",
      }),
      "inv_backfilled",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invite.id).toBe("inv_backfilled");
    expect(body.invite.status).toBe("revoked");
    expect(body.invite.friendName).toBe("Alice");
    expect(body.invite.voiceCodeDigits).toBe(6);
    // No secret hash field may ever reach the wire.
    expect(body.invite).not.toHaveProperty("inviteCodeHash");
    expect(body.invite).not.toHaveProperty("tokenHash");
    expect(body.invite).not.toHaveProperty("voiceCodeHash");
    expect(assistantDbRunMock).not.toHaveBeenCalled();
    expect(assistantDbQueryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("is idempotent on an already-terminal invite (returns its current state)", async () => {
    // revokeInvite() only flips an ACTIVE row to revoked; an already-redeemed
    // invite is returned unchanged with its terminal status.
    contactStoreRevokeInviteMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "redeemed",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1", {
        method: "DELETE",
      }),
      "inv_1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invite.status).toBe("redeemed");
    expect(assistantDbRunMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 404 when the invite id is unknown (no assistant DB fallback)", async () => {
    contactStoreRevokeInviteMock = mock(() => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/nope", {
        method: "DELETE",
      }),
      "nope",
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(assistantDbQueryMock).not.toHaveBeenCalled();
    expect(assistantDbRunMock).not.toHaveBeenCalled();
  });

  test("returns 500 on unexpected gateway error (no proxy fallback)", async () => {
    contactStoreRevokeInviteMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1", {
        method: "DELETE",
      }),
      "inv_1",
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleRedeemInvite (gateway-native)", () => {
  // The handler drives the gateway redemption engine directly — no assistant
  // relay, no gateway-side re-claim (the engine claims internally).

  function redeem(body: unknown) {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    return handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  const VOICE_OUTCOME: EngineOutcome = {
    inviteId: "inv_1",
    contactId: "ct_1",
    sourceChannel: "phone",
    memberExternalUserId: "+15551234567",
    result: "redeemed",
  };

  test("voice path dispatches to the voice engine and returns { ok, type, memberId, inviteId }", async () => {
    redeemVoiceInviteMock = mock(async () => ({
      status: "redeemed" as const,
      outcome: VOICE_OUTCOME,
    }));

    const res = await redeem({
      code: "123456",
      callerExternalUserId: "+15551234567",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      type: "redeemed",
      memberId: "ct_1",
      inviteId: "inv_1",
    });
    expect(redeemVoiceInviteMock.mock.calls[0][0]).toMatchObject({
      code: "123456",
      callerExternalUserId: "+15551234567",
    });
    // No assistant redeem relay ran (the daemon info-mirror event is fired
    // inside the engine, covered by the engine tests).
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("voice already_member returns no inviteId (nothing consumed)", async () => {
    redeemVoiceInviteMock = mock(async () => ({
      status: "already_member" as const,
      outcome: { ...VOICE_OUTCOME, result: "already_member" as const },
    }));

    const res = await redeem({
      code: "123456",
      callerExternalUserId: "+15551234567",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      type: "already_member",
      memberId: "ct_1",
    });
  });

  test("voice failure maps to 400 BAD_REQUEST with the generic reason", async () => {
    // Default engine mock fails with invalid_or_expired.
    const res = await redeem({
      code: "000000",
      callerExternalUserId: "+15551234567",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("invalid_or_expired");
  });

  test("token path dispatches to the token engine and returns the sanitized invite + type", async () => {
    redeemInviteByTokenMock = mock(async () => ({
      status: "redeemed" as const,
      outcome: { ...VOICE_OUTCOME, sourceChannel: "telegram" },
      replyText: "Welcome! You've been granted access.",
    }));
    // The response invite is the post-claim gateway row, hashes stripped.
    contactStoreGetInviteByIdMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "redeemed",
      useCount: 1,
      tokenHash: "tok_hash",
      voiceCodeHash: "voice_hash",
    }));

    const res = await redeem({
      token: "raw-token",
      sourceChannel: "telegram",
      externalUserId: "u_1",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.type).toBe("redeemed");
    expect(body.invite.id).toBe("inv_1");
    expect(body.invite.status).toBe("redeemed");
    expect(body.invite.useCount).toBe(1);
    // Redemption secrets never leave the DB.
    expect(body.invite.inviteCodeHash).toBeUndefined();
    expect(body.invite.tokenHash).toBeUndefined();
    expect(body.invite.voiceCodeHash).toBeUndefined();
    expect(redeemInviteByTokenMock.mock.calls[0][0]).toMatchObject({
      token: "raw-token",
      sourceChannel: "telegram",
      externalUserId: "u_1",
    });
    expect(contactStoreGetInviteByIdMock.mock.calls[0][0]).toBe("inv_1");
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("token already_member relays the type unchanged", async () => {
    redeemInviteByTokenMock = mock(async () => ({
      status: "already_member" as const,
      outcome: {
        ...VOICE_OUTCOME,
        sourceChannel: "telegram",
        result: "already_member" as const,
      },
      replyText: "You already have access.",
    }));

    const res = await redeem({
      token: "raw-token",
      sourceChannel: "telegram",
      externalUserId: "u_1",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.type).toBe("already_member");
    expect(body.invite.id).toBe("inv_1");
  });

  test("token engine failure maps the reason to 400 BAD_REQUEST", async () => {
    redeemInviteByTokenMock = mock(async () => ({
      status: "failed" as const,
      reason: "expired",
      replyText: "This invite is no longer valid.",
    }));

    const res = await redeem({
      token: "raw-token",
      sourceChannel: "telegram",
      externalUserId: "u_1",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("expired");
  });

  test("returns 400 when token redeem is missing sourceChannel (engine never runs)", async () => {
    const res = await redeem({ token: "tok" });

    expect(res.status).toBe(400);
    expect(redeemInviteByTokenMock).not.toHaveBeenCalled();
    expect(redeemVoiceInviteMock).not.toHaveBeenCalled();
  });

  test("returns 500 when the engine throws unexpectedly", async () => {
    redeemInviteByTokenMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });

    const res = await redeem({
      token: "tok",
      sourceChannel: "telegram",
      externalUserId: "u_1",
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("Failed to redeem invite");
  });
});

describe("handleCallInvite (gateway-native)", () => {
  // An active, unexpired phone invite bound to a caller number — the callable
  // fixture the gateway relays to the daemon.
  const PHONE_INVITE: InviteRow = {
    ...DEFAULT_INVITE,
    sourceChannel: "phone",
    expectedExternalUserId: "+15550100001",
    friendName: "Friend Label",
    guardianName: "Guardian Label",
  };

  function callInvite() {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    return handler.handleCallInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1/call", {
        method: "POST",
      }),
      "inv_1",
    );
  }

  test("relays the call for an active phone invite with the resolved call fields", async () => {
    contactStoreGetInviteByIdMock = mock(() => PHONE_INVITE);
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_trigger_call") {
        return { callSid: "CA123" };
      }
      return {};
    });

    const res = await callInvite();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.callSid).toBe("CA123");
    // The id lands at pathParams.id; the resolved call fields land in body.
    // The mock contact has no displayName, so friendName falls back to the
    // invite's friendName.
    expect(ipcCallAssistantMock.mock.calls[0]).toEqual([
      "invites_trigger_call",
      {
        pathParams: { id: "inv_1" },
        body: {
          phoneNumber: "+15550100001",
          friendName: "Friend Label",
          guardianName: "Guardian Label",
        },
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("prefers the bound contact's displayName over the invite friendName", async () => {
    contactStoreGetInviteByIdMock = mock(() => PHONE_INVITE);
    contactStoreGetContactMock = mock(() => ({
      id: "ct_1",
      displayName: "Curated Name",
    }));
    ipcCallAssistantMock = mock(async () => ({ callSid: "CA124" }));

    const res = await callInvite();

    expect(res.status).toBe(200);
    const relayed = ipcCallAssistantMock.mock.calls[0][1] as {
      body: Record<string, unknown>;
    };
    expect(relayed.body.friendName).toBe("Curated Name");
  });

  test("returns 404 when no gateway row exists (row is the lifecycle authority — no daemon fall-through)", async () => {
    contactStoreGetInviteByIdMock = mock(() => null);

    const res = await callInvite();

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/not found/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 when the invite is not active", async () => {
    contactStoreGetInviteByIdMock = mock(() => ({
      ...PHONE_INVITE,
      status: "revoked",
    }));

    const res = await callInvite();

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not active/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 400 and sweeps the row when the invite has expired", async () => {
    contactStoreGetInviteByIdMock = mock(() => ({
      ...PHONE_INVITE,
      expiresAt: Date.now() - 1,
    }));

    const res = await callInvite();

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/expired/);
    expect(contactStoreMarkInviteExpiredMock).toHaveBeenCalledWith("inv_1");
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 400 for a non-phone invite", async () => {
    contactStoreGetInviteByIdMock = mock(() => DEFAULT_INVITE); // telegram

    const res = await callInvite();

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/phone invites/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 400 for a phone invite missing the bound caller number", async () => {
    contactStoreGetInviteByIdMock = mock(() => ({
      ...PHONE_INVITE,
      expectedExternalUserId: null,
    }));

    const res = await callInvite();

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/voice metadata/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 500 when the call relay throws unexpectedly", async () => {
    contactStoreGetInviteByIdMock = mock(() => PHONE_INVITE);
    ipcCallAssistantMock = mock(async () => {
      throw new Error("ipc transport failure");
    });

    const res = await callInvite();

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

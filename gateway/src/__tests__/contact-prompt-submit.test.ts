/**
 * Tests for POST /v1/contacts/prompt/submit.
 *
 * Covers the key contact-first resolution logic:
 * - Guardian prompts always bind to the existing guardian contact.
 * - Guardian prompts conflict (409) when the channel belongs to another contact.
 * - Non-guardian prompts create or reuse contacts via channel lookup.
 * - The gateway DB is the source of truth; the assistant identity mirror is
 *   driven over typed `contacts_mirror_*` IPC ops (asserted by payload — the
 *   daemon-side write semantics are pinned in the daemon's mirror suites).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// ---------------------------------------------------------------------------
// Mock IPC so mirror ops + resolve_contact_prompt don't dial a real socket.
// Method name → error to throw on the next call to it (mirror-failure tests).
// ---------------------------------------------------------------------------

const ipcThrowOn = new Map<string, Error>();

/**
 * What `contact_prompt_flags` reports the parked form was opened with: the
 * verify flag and the contact the command targeted. Set per test.
 */
let parkedFlags: Record<string, unknown> = {};

/**
 * The notes each contact holds in the assistant mirror, keyed by contact id.
 *
 * Notes live only there, so the mirror write op fills this and the info read
 * serves from it. A mirror write a test makes throw leaves no entry, which is
 * what an unreachable mirror looks like to a read-back.
 */
const mirrorNotes = new Map<string, string | null>();

function recordMirrorWrite(payload: unknown): void {
  const body = (payload as { body?: Record<string, unknown> } | undefined)
    ?.body;
  const contactId = body?.contactId;
  if (typeof contactId === "string") {
    const notes = body?.notes;
    mirrorNotes.set(contactId, typeof notes === "string" ? notes : null);
  }
}

function mirrorInfoBatch(payload: unknown): Record<string, unknown> {
  const ids = (payload as { body?: { contactIds?: unknown } } | undefined)?.body
    ?.contactIds;
  const contactIds = Array.isArray(ids) ? (ids as string[]) : [];
  return {
    infos: contactIds
      .filter((id) => mirrorNotes.has(id))
      .map((id) => ({
        contactId: id,
        notes: mirrorNotes.get(id) ?? null,
        userFile: null,
        contactType: null,
        assistantMetadata: null,
      })),
  };
}

/**
 * The gateway claims a form before writing, so every submission in this suite
 * needs the claim granted unless the test is about losing it. Shared with the
 * per-test overrides below so none of them can drop it by omission.
 */
function defaultIpcResponse(
  method: string,
  payload?: unknown,
): Record<string, unknown> {
  if (method === "contact_prompt_claim") {
    return { claimed: true, settleMs: 180_000 };
  }
  if (method === "contact_prompt_flags") {
    // A daemon still holding the form reports known:true alongside whatever it
    // parked. A test overrides it to stand in for one that has forgotten it.
    return { known: true, ...parkedFlags };
  }
  if (
    method === "contacts_mirror_upsert_full" ||
    method === "contacts_mirror_upsert_contact"
  ) {
    recordMirrorWrite(payload);
    return { ok: true };
  }
  if (method === "contacts_info_batch") {
    return mirrorInfoBatch(payload);
  }
  return { resolved: true };
}

const ipcMock = mock(async (method: string, payload?: unknown) => {
  const err = ipcThrowOn.get(method);
  if (err) {
    ipcThrowOn.delete(method);
    throw err;
  }
  return defaultIpcResponse(method, payload);
});

// Spread the actual module so untouched exports (IpcHandlerError,
// IpcTransportError, ipcSuggestTrustRule) stay importable by later-loaded
// files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: ipcMock,
}));

// ---------------------------------------------------------------------------
// Imports that depend on the mocks above.
// ---------------------------------------------------------------------------

const { handleContactPromptSubmit } =
  await import("../http/routes/contact-prompt.js");
const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contactChannels: gwContactChannels, contacts: gwContacts } =
  await import("../db/schema.js");
const { ContactStore } = await import("../db/contact-store.js");
const { eq } = await import("drizzle-orm");

// ---------------------------------------------------------------------------
// Request factory
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:7830/v1/contacts/prompt/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// IPC call inspectors
//
// The handler fires two IPC operations on a successful mutating submit: an
// `emit_event` { kind: "contacts_changed" } cache-invalidation broadcast plus
// the `resolve_contact_prompt` that unblocks the CLI. These helpers pick the
// right call regardless of order.
// ---------------------------------------------------------------------------

function callsFor(
  ipc: typeof ipcMock,
  op: string,
): { body: Record<string, unknown> }[] {
  return (ipc.mock.calls as any[][])
    .filter((c) => c[0] === op)
    .map((c) => c[1] as { body: Record<string, unknown> });
}

function resolveCall(ipc: typeof ipcMock): { body: Record<string, unknown> } {
  const calls = callsFor(ipc, "resolve_contact_prompt");
  expect(calls).toHaveLength(1);
  return calls[0];
}

function expectEmittedContactsChanged(ipc: typeof ipcMock): void {
  const calls = callsFor(ipc, "emit_event");
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(calls.some((c) => c.body.kind === "contacts_changed")).toBe(true);
}

function expectNoEmit(ipc: typeof ipcMock): void {
  expect(callsFor(ipc, "emit_event")).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  ipcMock.mockClear();
  ipcMock.mockImplementation(async (method: string, payload?: unknown) => {
    const err = ipcThrowOn.get(method);
    if (err) {
      ipcThrowOn.delete(method);
      throw err;
    }
    return defaultIpcResponse(method, payload);
  });
  ipcThrowOn.clear();
  parkedFlags = {};
  mirrorNotes.clear();

  const gwDb = getGatewayDb();
  gwDb.delete(gwContactChannels).run();
  gwDb.delete(gwContacts).run();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleContactPromptSubmit", () => {
  // Seed a guardian contact into the gateway DB (source of truth). The
  // assistant identity mirror is not modeled here — mirror writes are
  // asserted as typed IPC payloads.
  function seedGuardian(id = "guardian-1", name = "Vargas"): void {
    const now = Date.now();
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id,
        displayName: name,
        role: "guardian",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  test("guardian prompt — binds channel to existing gateway guardian, role preserved", async () => {
    seedGuardian();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-1",
        address: "+12125550123",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Gateway DB is the source of truth: channel row bound to the guardian.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550123"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe("guardian-1");

    // Guardian role must be preserved on the gateway contact row.
    const gwGuardian = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "guardian-1"))
      .all();
    expect(gwGuardian).toHaveLength(1);
    expect(gwGuardian[0].role).toBe("guardian");

    // IPC should have been called with the guardian contactId + gateway channel id.
    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.contactId).toBe("guardian-1");
    expect(ipcCall.body.channelId).toBe(gwChannels[0].id);

    // A successful guardian bind invalidates the daemon guardian-id cache.
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian prompt — --verify attests the submitted channel", async () => {
    seedGuardian();
    parkedFlags = { verify: true };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-verify",
        address: "+12025550142",
        channelType: "imessage",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const discovered = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.type, "imessage"))
      .get();
    expect(discovered).toBeDefined();
    expect(discovered!.status).toBe("active");
    expect(discovered!.verifiedVia).toBe("manual");
    expect(discovered!.address).toBe("+12025550142");

    const pluginRows = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.type, "plugin"))
      .all();
    expect(pluginRows).toHaveLength(0);

    const flags = callsFor(ipcMock, "contact_prompt_flags");
    expect(flags).toHaveLength(1);
    expect(flags[0].body.requestId).toBe("req-verify");
  });

  test("a dismissal unblocks the command and writes nothing", async () => {
    seedGuardian();

    const res = await handleContactPromptSubmit(
      makeRequest({ requestId: "req-dismiss", cancelled: true }),
    );

    expect(res.status).toBe(200);
    expect(getGatewayDb().select().from(gwContactChannels).all()).toHaveLength(
      0,
    );
    expect(resolveCall(ipcMock).body.error).toBe("Cancelled by user");
  });

  test("a dismissal that loses the claim leaves the answer in flight alone", async () => {
    seedGuardian();
    ipcMock.mockImplementation(async (method: string) => {
      if (method === "contact_prompt_claim") {
        return { claimed: false, reason: "already_claimed" };
      }
      return defaultIpcResponse(method);
    });

    const res = await handleContactPromptSubmit(
      makeRequest({ requestId: "req-dismiss-late", cancelled: true }),
    );

    expect(res.status).toBe(200);
    expect(callsFor(ipcMock, "resolve_contact_prompt")).toHaveLength(0);
  });

  test("a submission that loses the claim writes nothing", async () => {
    seedGuardian();
    // A second client answering the same broadcast, after the first already
    // has the claim.
    ipcMock.mockImplementation(async (method: string) => {
      if (method === "contact_prompt_claim") {
        return { claimed: false, reason: "already_claimed" };
      }
      return defaultIpcResponse(method);
    });

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-lost-claim",
        address: "+12025550147",
        channelType: "imessage",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, duplicate: true });
    expect(getGatewayDb().select().from(gwContactChannels).all()).toHaveLength(
      0,
    );
    expect(callsFor(ipcMock, "resolve_contact_prompt")).toHaveLength(0);
  });

  test("submitted verify:true attests over a parked flag that says no", async () => {
    seedGuardian();
    // The parked flag says no. The form says yes, and the form is the answer.
    parkedFlags = { verify: false };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-box-checked",
        address: "+12025550143",
        channelType: "imessage",
        role: "guardian",
        verify: true,
      }),
    );

    expect(res.status).toBe(200);
    const channel = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12025550143"))
      .get();
    expect(channel!.verifiedVia).toBe("manual");
  });

  test("the resolve reports what the channel actually is, not what was asked", async () => {
    seedGuardian();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-report-verified",
        address: "+12025550145",
        channelType: "imessage",
        role: "guardian",
        verify: true,
      }),
    );

    expect(res.status).toBe(200);
    // The command prints this, and the guardian's checkbox is what decides it.
    expect(resolveCall(ipcMock).body.verified).toBe(true);
  });

  test("a failed re-attest reports the channel as it stands", async () => {
    seedGuardian();
    // Bind and attest the channel first.
    await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-first-attest",
        address: "+12025550148",
        channelType: "imessage",
        role: "guardian",
        verify: true,
      }),
    );

    // On the prototype: the handler holds its own ContactStore, so spying on a
    // fresh instance would leave the real method in place and prove nothing.
    const attest = spyOn(ContactStore.prototype, "markChannelVerified");
    attest.mockImplementation(() => {
      throw new Error("attest exploded");
    });

    // Re-submitting the same address reuses the verified channel. A failed
    // re-attest changes nothing, so reporting it unverified would invent a
    // downgrade that never happened.
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-reattest",
        address: "+12025550148",
        channelType: "imessage",
        role: "guardian",
        verify: true,
      }),
    );
    // Read the call count before restoring: restoring clears the record.
    const attestCalls = attest.mock.calls.length;
    attest.mockRestore();

    expect(res.status).toBe(200);
    expect(attestCalls).toBeGreaterThan(0);
    // The channel is still attested, so that is what the command hears.
    const resolves = callsFor(ipcMock, "resolve_contact_prompt");
    expect(resolves[resolves.length - 1]!.body.verified).toBe(true);
  });

  test("an unchecked box resolves as unverified", async () => {
    seedGuardian();

    await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-report-unverified",
        address: "+12025550146",
        channelType: "imessage",
        role: "guardian",
        verify: false,
      }),
    );

    expect(resolveCall(ipcMock).body.verified).toBe(false);
  });

  test("submitted verify:false leaves the channel unverified even when the command asked for --verify", async () => {
    seedGuardian();
    // The guardian unchecked the box the command pre-checked. Their answer wins.
    parkedFlags = { verify: true };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-box-unchecked",
        address: "+12025550144",
        channelType: "imessage",
        role: "guardian",
        verify: false,
      }),
    );

    expect(res.status).toBe(200);
    const channel = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12025550144"))
      .get();
    expect(channel!.verifiedVia).toBeNull();
  });

  test("guardian prompt — reuses channel already bound to guardian", async () => {
    const now = Date.now();
    seedGuardian();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-1",
        contactId: "guardian-1",
        type: "phone",
        address: "+12125550123",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 5,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-2",
        address: "+12125550123",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // No new channel should have been inserted in the gateway DB.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.type, "phone"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-1");

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe("chan-1");
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian prompt — 409 when channel already belongs to another contact", async () => {
    const now = Date.now();
    seedGuardian();
    // A different (orphaned or stale) contact that owns the channel in the
    // gateway DB.
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id: "other-1",
        displayName: "Orphan",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-other",
        contactId: "other-1",
        type: "phone",
        address: "+12125550123",
        isPrimary: true,
        status: "unverified",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-3",
        address: "+12125550123",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);

    // The stale gateway channel must not have been deleted or reassigned, and no
    // new channel row created for the guardian.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.type, "phone"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-other");
    expect(gwChannels[0].contactId).toBe("other-1");

    // No mirror op fired either — the conflict aborts before any upsert.
    expect(callsFor(ipcMock, "contacts_mirror_upsert_full")).toHaveLength(0);

    // The CLI is told, so it doesn't hang. Asserted by what was sent rather
    // than by a call count, since claiming the form is a call of its own.
    const ipcCall = resolveCall(ipcMock);
    expect(typeof ipcCall.body.error).toBe("string");

    // A 409 conflict mutated nothing — no cache-invalidation broadcast.
    expectNoEmit(ipcMock);
  });

  test("guardian prompt — accepted even when the mirror op throws (gateway-first)", async () => {
    seedGuardian();

    // Make the best-effort typed mirror op fail. The gateway-first write
    // must still succeed and the request still be accepted.
    ipcThrowOn.set(
      "contacts_mirror_upsert_full",
      new Error("assistant DB mirror unavailable"),
    );

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-mirror-g",
        address: "+12125550124",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Gateway DB guardian channel row is present despite the mirror failure.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550124"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe("guardian-1");
  });

  test("guardian prompt — creates guardian gateway-first when none exists (bootstrap sub-case)", async () => {
    // No guardian seeded anywhere — handler must mint one gateway-first.
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-boot",
        address: "+12125550125",
        channelType: "phone",
        role: "guardian",
        displayName: "Boot Guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Guardian created in the gateway DB with role=guardian.
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(1);
    expect(gwGuardians[0].displayName).toBe("Boot Guardian");

    // Channel bound to the newly minted guardian.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550125"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe(gwGuardians[0].id);

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.contactId).toBe(gwGuardians[0].id);
    expectEmittedContactsChanged(ipcMock);
  });

  test("non-guardian prompt — creates new contact and channel (gateway-first)", async () => {
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-4",
        address: "alice@example.com",
        channelType: "email",
        role: "trusted-contact",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(200);

    // Gateway DB is the source of truth: contact + channel rows must exist
    // (unverified / allow / primary).
    const gwContactRows = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.displayName, "Alice"))
      .all();
    expect(gwContactRows).toHaveLength(1);
    expect(gwContactRows[0].role).toBe("contact");

    const gwChannelRows = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "alice@example.com"))
      .all();
    expect(gwChannelRows).toHaveLength(1);
    expect(gwChannelRows[0].contactId).toBe(gwContactRows[0].id);
    expect(gwChannelRows[0].status).toBe("unverified");
    expect(gwChannelRows[0].policy).toBe("allow");
    expect(gwChannelRows[0].isPrimary).toBe(true);

    // The channel id handed to resolve_contact_prompt matches the gateway row.
    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe(gwChannelRows[0].id);
    expect(ipcCall.body.contactId).toBe(gwContactRows[0].id);

    // A successful non-guardian upsert invalidates the daemon contact caches.
    expectEmittedContactsChanged(ipcMock);
  });

  test("non-guardian prompt — one contacts_mirror_upsert_full op carries the gateway contact + channel ids", async () => {
    // The identity mirror is ONE typed transactional op; it must ship the
    // just-written gateway ids so the daemon-side rows adopt them (daemon
    // write semantics pinned in contacts-mirror-upsert-full.test.ts).
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-mirror-op",
        address: "carol@example.com",
        channelType: "email",
        role: "trusted-contact",
        displayName: "Carol",
      }),
    );

    expect(res.status).toBe(200);

    const gwChannelRows = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "carol@example.com"))
      .all();
    expect(gwChannelRows).toHaveLength(1);

    const mirror = callsFor(ipcMock, "contacts_mirror_upsert_full");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body.contactId).toBe(gwChannelRows[0].contactId);
    const channels = mirror[0].body.channels as {
      id?: string;
      type: string;
      address: string;
      isPrimary?: boolean;
    }[];
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe(gwChannelRows[0].id);
    expect(channels[0].type).toBe("email");
    expect(channels[0].address).toBe("carol@example.com");
    expect(channels[0].isPrimary).toBe(true);
  });

  test("non-guardian prompt — accepted even when the mirror op throws (gateway-first)", async () => {
    // Make the best-effort typed mirror op fail. The gateway-first write
    // must still succeed and the request still be accepted.
    ipcThrowOn.set(
      "contacts_mirror_upsert_full",
      new Error("assistant DB mirror unavailable"),
    );

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-mirror",
        address: "bob@example.com",
        channelType: "email",
        role: "trusted-contact",
        displayName: "Bob",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Gateway DB rows are present despite the mirror failure.
    const gwChannelRows = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "bob@example.com"))
      .all();
    expect(gwChannelRows).toHaveLength(1);

    const gwContactRows = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, gwChannelRows[0].contactId))
      .all();
    expect(gwContactRows).toHaveLength(1);
  });

  test("non-guardian prompt — reuses existing gateway contact and preserves name when displayName omitted", async () => {
    const now = Date.now();
    // Seed an existing gateway contact + channel (gateway DB is the source of
    // truth for the reuse-by-channel lookup).
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id: "contact-1",
        displayName: "Alice",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-alice",
        contactId: "contact-1",
        type: "email",
        address: "alice@example.com",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 3,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-5",
        address: "alice@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);

    // No duplicate contact row; the existing contact id is reused.
    const gwContactRows = getGatewayDb().select().from(gwContacts).all();
    expect(gwContactRows).toHaveLength(1);
    expect(gwContactRows[0].id).toBe("contact-1");
    // display_name not clobbered when displayName omitted from the body.
    expect(gwContactRows[0].displayName).toBe("Alice");

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.contactId).toBe("contact-1");
    expectEmittedContactsChanged(ipcMock);
  });

  test("non-guardian prompt — explicit null displayName is treated as omitted (preserves name, no 500)", async () => {
    const now = Date.now();
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id: "contact-1",
        displayName: "Alice",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-alice",
        contactId: "contact-1",
        type: "email",
        address: "alice@example.com",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 3,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // displayName: null must NOT be written through to the NOT NULL column.
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-null",
        address: "alice@example.com",
        channelType: "email",
        displayName: null,
      }),
    );

    expect(res.status).toBe(200);

    const gwContactRows = getGatewayDb().select().from(gwContacts).all();
    expect(gwContactRows).toHaveLength(1);
    expect(gwContactRows[0].id).toBe("contact-1");
    expect(gwContactRows[0].displayName).toBe("Alice");
  });

  test("gateway DB receives the new channel bound to the existing guardian", async () => {
    seedGuardian();

    await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-6",
        address: "+12125550126",
        channelType: "phone",
        role: "guardian",
      }),
    );

    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550126"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe("guardian-1");
  });

  test("guardian prompt — reuse path fires the mirror-heal upsert op with the existing channel id", async () => {
    const now = Date.now();
    seedGuardian();
    // Gateway channel already bound to the guardian (the reuse precondition).
    // The reuse path still runs upsertContact so a mirror that missed the
    // original bind is healed by the typed op (daemon-side upsert pinned in
    // contacts-mirror-upsert-full.test.ts).
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-reuse",
        contactId: "guardian-1",
        type: "phone",
        address: "+15551112222",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-heal",
        address: "+15551112222",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // No new gateway channel — the existing one is reused.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+15551112222"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-reuse");

    // The mirror-heal op targets the guardian and ships the existing gateway
    // channel id for daemon-side id alignment.
    const mirror = callsFor(ipcMock, "contacts_mirror_upsert_full");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body.contactId).toBe("guardian-1");
    const channels = mirror[0].body.channels as { id?: string }[];
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("chan-reuse");

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe("chan-reuse");
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian reuse — mirror-heal upsert throwing is non-fatal (still accepted, reuses channel)", async () => {
    const now = Date.now();
    seedGuardian();
    // Gateway channel already bound to the guardian — reuse precondition.
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-reuse-fail",
        contactId: "guardian-1",
        type: "phone",
        address: "+15558887777",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // The reuse-branch mirror-heal upsertContact throws (e.g. transient
    // gateway SQLITE_BUSY). The reuse path must stay success-guaranteed.
    const spy = spyOn(
      ContactStore.prototype,
      "upsertContact",
    ).mockImplementation(async () => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-reuse-fail",
          address: "+15558887777",
          channelType: "phone",
          role: "guardian",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Existing gateway channel reused — no new row, no reassignment.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+15558887777"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-reuse-fail");
    expect(gwChannels[0].contactId).toBe("guardian-1");

    // Daemon resolved with the existing channel id (success, not error).
    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe("chan-reuse-fail");
    expect(ipcCall.body.error).toBeUndefined();
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian bootstrap-create — gateway is authoritative; no ACL role crosses the mirror ops", async () => {
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-boot-role",
        address: "+15554445555",
        channelType: "phone",
        role: "guardian",
        displayName: "Role Guardian",
      }),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).accepted).toBe(true);

    // Gateway DB is the source of truth for the guardian ACL role.
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(1);

    // The identity mirror carries no ACL role: neither the contact-create op
    // nor the channel-bind op includes one.
    const mirrorBodies = [
      ...callsFor(ipcMock, "contacts_mirror_upsert_contact"),
      ...callsFor(ipcMock, "contacts_mirror_upsert_full"),
    ];
    expect(mirrorBodies.length).toBeGreaterThanOrEqual(1);
    for (const call of mirrorBodies) {
      expect(call.body.contactId).toBe(gwGuardians[0].id);
      expect("role" in call.body).toBe(false);
    }
  });

  test("non-guardian prompt — 500 + daemon error when channel can't be resolved (no empty channelId)", async () => {
    // Force resolveChannelId to miss by making getChannelsForContact return [].
    const spy = spyOn(
      ContactStore.prototype,
      "getChannelsForContact",
    ).mockReturnValue([]);

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-noresolve",
          address: "carol@example.com",
          channelType: "email",
          role: "trusted-contact",
          displayName: "Carol",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);

    // Daemon was notified with an error (not a success resolve with empty id).
    const ipcCall = resolveCall(ipcMock);
    expect(typeof ipcCall.body.error).toBe("string");
    expect(ipcCall.body.channelId).toBeUndefined();

    // The non-guardian upsert already committed (no rollback on this path)
    // before the read-back miss, so the caches are still invalidated — the
    // emit fires before the channel-id guard.
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian bind — rolls back freshly-created guardian + 500 when channel can't be resolved", async () => {
    // No guardian seeded: the handler mints one gateway-first, then binds the
    // channel. Force the post-bind resolve to miss so the empty-channelId guard
    // fires and the just-created guardian is cleaned up.
    const spy = spyOn(
      ContactStore.prototype,
      "getChannelsForContact",
    ).mockReturnValue([]);

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-boot-noresolve",
          address: "+15553334444",
          channelType: "phone",
          role: "guardian",
          displayName: "Doomed Guardian",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);

    // The freshly-created guardian was rolled back (compensating delete).
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(0);

    // Daemon notified with an error.
    const ipcCall = resolveCall(ipcMock);
    expect(typeof ipcCall.body.error).toBe("string");

    // The rolled-back bind mutated nothing net — no cache-invalidation broadcast.
    expectNoEmit(ipcMock);
  });

  test("guardian bind — existing guardian, read-back miss still emits (committed bind, no rollback)", async () => {
    // An existing guardian is bound to a NEW channel; the post-bind resolve
    // misses. rollbackCreatedContact is a no-op (the guardian wasn't created
    // here), so the committed channel bind persists and the caches MUST be
    // invalidated despite the 500.
    seedGuardian();
    const spy = spyOn(
      ContactStore.prototype,
      "getChannelsForContact",
    ).mockReturnValue([]);

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-existing-noresolve",
          address: "+12125550188",
          channelType: "phone",
          role: "guardian",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(500);

    // The existing guardian was NOT rolled back.
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(1);

    // Committed bind on an existing guardian — caches invalidated despite 500.
    expectEmittedContactsChanged(ipcMock);
  });
  // -------------------------------------------------------------------------
  // Targeted binds: the parked form says which contact the address is for.
  // -------------------------------------------------------------------------

  function seedContact(id: string, name: string): void {
    const now = Date.now();
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id,
        displayName: name,
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  function seedChannel(id: string, contactId: string, address: string): void {
    const now = Date.now();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id,
        contactId,
        type: "email",
        address,
        isPrimary: true,
        status: "unverified",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  test("targeted bind: attaches the channel to the contact the form named", async () => {
    seedContact("c-alice", "Alice");
    parkedFlags = { contactId: "c-alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target",
        address: "alice.work@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);

    // The address joins the named contact instead of minting a duplicate
    // named after itself.
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    const channels = getGatewayDb().select().from(gwContactChannels).all();
    expect(channels).toHaveLength(1);
    expect(channels[0].contactId).toBe("c-alice");

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.contactId).toBe("c-alice");
    expect(ipcCall.body.channelId).toBe(channels[0].id);
    expectEmittedContactsChanged(ipcMock);
  });

  test("targeted bind: the mirror repair carries the target's stored name", async () => {
    seedContact("c-alice", "Alice Chen");
    parkedFlags = { known: true, verify: false, contactId: "c-alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target-mirror-name",
        address: "alice.mirror@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);
    // The mirror row can be missing, and its create path names a contact after
    // the channel address when the op carries no name.
    const mirror = callsFor(ipcMock, "contacts_mirror_upsert_full");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body.contactId).toBe("c-alice");
    expect(mirror[0].body.displayName).toBe("Alice Chen");
  });

  test("targeted bind: reuses a channel the target already holds", async () => {
    seedContact("c-alice", "Alice");
    seedChannel("chan-alice", "c-alice", "alice@example.com");
    parkedFlags = { contactId: "c-alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target-reuse",
        address: "alice@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);
    const channels = getGatewayDb().select().from(gwContactChannels).all();
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("chan-alice");
    expect(resolveCall(ipcMock).body.channelId).toBe("chan-alice");
  });

  test("targeted bind: 409 naming the contact the address belongs to", async () => {
    seedContact("c-alice", "Alice");
    seedContact("c-bob", "Bob");
    seedChannel("chan-bob", "c-bob", "bob@example.com");
    parkedFlags = { contactId: "c-alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target-conflict",
        address: "bob@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain('"Bob"');
    expect(body.error).toContain("c-bob");
    expect(body.error).toContain("assistant contacts merge");

    // Nothing moved: the channel still belongs to Bob and no channel was
    // minted for the target.
    const channels = getGatewayDb().select().from(gwContactChannels).all();
    expect(channels).toHaveLength(1);
    expect(channels[0].contactId).toBe("c-bob");
    expect(callsFor(ipcMock, "contacts_mirror_upsert_full")).toHaveLength(0);
    expect(typeof resolveCall(ipcMock).body.error).toBe("string");
    expectNoEmit(ipcMock);
  });

  test("targeted bind: 404 for an id no contact has, minting nothing", async () => {
    parkedFlags = { contactId: "no-such-contact" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target-missing",
        address: "ghost@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("no-such-contact");
    expect(body.error).toContain("assistant contacts list");

    // An unknown explicit id is an INSERT in ContactStore, so the guard is
    // what keeps a typo from minting a contact named after the address.
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
    expect(getGatewayDb().select().from(gwContactChannels).all()).toHaveLength(
      0,
    );
    expectNoEmit(ipcMock);
  });

  test("targeted bind: an unreadable parked target falls back to the client's echo", async () => {
    seedContact("c-alice", "Alice");
    ipcThrowOn.set("contact_prompt_flags", new Error("daemon unreachable"));

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target-echo",
        address: "alice.echo@example.com",
        channelType: "email",
        contactId: "c-alice",
      }),
    );

    expect(res.status).toBe(200);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    const channels = getGatewayDb().select().from(gwContactChannels).all();
    expect(channels).toHaveLength(1);
    expect(channels[0].contactId).toBe("c-alice");
  });

  test("targeted bind: a readable untargeted form ignores an echoed contact id", async () => {
    seedContact("c-alice", "Alice");

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-echo-injection",
        address: "stranger@example.com",
        channelType: "email",
        contactId: "c-alice",
      }),
    );

    // The form named no target, so the address gets its own contact. Honoring
    // the echo here would let a stale or crafted submission attach an address
    // to a contact the guardian's card never showed.
    expect(res.status).toBe(200);
    const aliceChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.contactId, "c-alice"))
      .all();
    expect(aliceChannels).toHaveLength(0);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(2);
  });

  test("targeted bind: 503 when neither the parked target nor an echo says who to bind", async () => {
    seedContact("c-alice", "Alice");
    ipcThrowOn.set("contact_prompt_flags", new Error("daemon unreachable"));

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target-unreadable",
        address: "mystery@example.com",
        channelType: "email",
      }),
    );

    // An untargeted form is indistinguishable from one whose target could not
    // be read, so resolving from the address could bind it to somebody the
    // guardian's card never named.
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);
    expect(body.error).toContain("Nothing was written");

    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    expect(getGatewayDb().select().from(gwContactChannels).all()).toHaveLength(
      0,
    );
    expect(callsFor(ipcMock, "contacts_mirror_upsert_full")).toHaveLength(0);
    expectNoEmit(ipcMock);

    // The parked command hears why, rather than sitting until its settle timer.
    expect(resolveCall(ipcMock).body.error).toContain("Nothing was written");
  });

  test("targeted bind: the named target wins over a submitted guardian role", async () => {
    seedGuardian();
    seedContact("c-alice", "Alice");
    parkedFlags = { contactId: "c-alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-target-over-role",
        address: "alice.role@example.com",
        channelType: "email",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);

    // The card named Alice, so the address is Alice's; a role the client sent
    // alongside it must not hand the address guardian identity.
    const channels = getGatewayDb().select().from(gwContactChannels).all();
    expect(channels).toHaveLength(1);
    expect(channels[0].contactId).toBe("c-alice");
    expect(
      getGatewayDb()
        .select()
        .from(gwContactChannels)
        .where(eq(gwContactChannels.contactId, "guardian-1"))
        .all(),
    ).toHaveLength(0);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(2);

    expect(resolveCall(ipcMock).body.contactId).toBe("c-alice");
  });

  test("named create: the contact takes the proposed name and notes, not the address", async () => {
    parkedFlags = { displayName: "Alice", notes: "Neighbour" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-named-create",
        address: "alice@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);
    const contacts = getGatewayDb().select().from(gwContacts).all();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].displayName).toBe("Alice");

    // Notes are assistant-owned, so they reach the DB over the mirror op.
    const mirror = callsFor(ipcMock, "contacts_mirror_upsert_full");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body.displayName).toBe("Alice");
    expect(mirror[0].body.notes).toBe("Neighbour");

    // The mirror took them, so the CLI is told they landed.
    expect(resolveCall(ipcMock).body.notesSaved).toBe(true);
  });

  test("named create: notes the mirror never took are reported as unsaved", async () => {
    parkedFlags = { displayName: "Alice", notes: "Neighbour" };
    // Notes live only in the assistant mirror and upsertContact swallows a
    // failed write to it, so the read-back is the only thing that can tell.
    ipcThrowOn.set("contacts_mirror_upsert_full", new Error("mirror down"));

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-named-create-no-mirror",
        address: "alice.nomirror@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);
    // The gateway contact and its channel still committed.
    const contacts = getGatewayDb().select().from(gwContacts).all();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].displayName).toBe("Alice");

    // A resolution, not a failure: the bind stands and the CLI is told which
    // part of it did not.
    const resolved = resolveCall(ipcMock).body;
    expect(resolved.error).toBeUndefined();
    expect(resolved.contactId).toBe(contacts[0].id);
    expect(resolved.notesSaved).toBe(false);
  });

  test("a create proposing no notes reports nothing about them", async () => {
    parkedFlags = { displayName: "Alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-named-create-no-notes",
        address: "alice.nonotes@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);
    expect(resolveCall(ipcMock).body.notesSaved).toBeUndefined();
  });

  test("parked notes are kept when the form proposes no name", async () => {
    parkedFlags = { notes: "Neighbour" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-notes-only",
        address: "neighbour@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);

    // Notes and name are independently optional, so a nameless confirmation
    // still carries the notes the guardian saw over the mirror op.
    const mirror = callsFor(ipcMock, "contacts_mirror_upsert_full");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body.notes).toBe("Neighbour");
    expect(mirror[0].body.displayName).toBeUndefined();
  });

  test("named create: the name the guardian left in the form wins over the parked one", async () => {
    parkedFlags = { displayName: "Alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-named-edited",
        address: "alice.edited@example.com",
        channelType: "email",
        displayName: "Alice Green",
      }),
    );

    expect(res.status).toBe(200);
    const contacts = getGatewayDb().select().from(gwContacts).all();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].displayName).toBe("Alice Green");
  });

  test("named create: 409 rather than renaming the contact that holds the address", async () => {
    seedContact("c-bob", "Bob");
    seedChannel("chan-bob", "c-bob", "bob@example.com");
    parkedFlags = { displayName: "Alice" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-named-conflict",
        address: "bob@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain('"Bob"');

    // An upsert matching on the channel would have renamed Bob to Alice.
    const contacts = getGatewayDb().select().from(gwContacts).all();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].displayName).toBe("Bob");
    expectNoEmit(ipcMock);
  });

  test("503 when the daemon no longer holds the form and no echo says who to bind", async () => {
    seedContact("c-alice", "Alice");
    // A restart between the claim and this read leaves a daemon that answers
    // the flags call successfully about a form it knows nothing about.
    parkedFlags = { known: false };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-forgotten",
        address: "mystery@example.com",
        channelType: "email",
      }),
    );

    // Read as "no target parked", the address would resolve itself and could
    // land on a contact the guardian's card never named.
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);
    expect(body.error).toContain("Nothing was written");

    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    expect(getGatewayDb().select().from(gwContactChannels).all()).toHaveLength(
      0,
    );
    expect(callsFor(ipcMock, "contacts_mirror_upsert_full")).toHaveLength(0);
    expectNoEmit(ipcMock);
    expect(resolveCall(ipcMock).body.error).toContain("Nothing was written");
  });

  test("parked notes with no proposed name: 409 rather than rewriting the notes of the contact that holds the address", async () => {
    seedContact("c-bob", "Bob");
    seedChannel("chan-bob", "c-bob", "bob@example.com");
    parkedFlags = { notes: "Neighbour" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-notes-conflict",
        address: "bob@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain('"Bob"');
    expect(body.error).toContain("assistant contacts merge");

    // Notes are assistant-owned, so an upsert resolving the address to Bob
    // would have overwritten his over the mirror op.
    expect(callsFor(ipcMock, "contacts_mirror_upsert_full")).toHaveLength(0);
    expect(callsFor(ipcMock, "contacts_mirror_upsert_contact")).toHaveLength(0);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    expect(getGatewayDb().select().from(gwContactChannels).all()).toHaveLength(
      1,
    );
    expectNoEmit(ipcMock);
  });

  test("guardian bootstrap takes the parked name and notes, not the address", async () => {
    parkedFlags = { displayName: "Vargas", notes: "Lives upstairs" };

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-guardian-parked",
        address: "vargas@example.com",
        channelType: "email",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);

    // A client with nowhere to type a name still bootstraps the guardian under
    // the one the form proposed, rather than under the address.
    const contacts = getGatewayDb().select().from(gwContacts).all();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].role).toBe("guardian");
    expect(contacts[0].displayName).toBe("Vargas");

    // Notes are assistant-owned, so they reach the DB over the mirror op.
    const mirror = callsFor(ipcMock, "contacts_mirror_upsert_contact");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body.displayName).toBe("Vargas");
    expect(mirror[0].body.notes).toBe("Lives upstairs");
  });
});

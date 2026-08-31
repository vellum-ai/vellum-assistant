/**
 * Tests for POST /v1/contacts/record/submit.
 *
 * This is the write half of the guardian-confirmed contact form: the daemon
 * parks a CLI call and broadcasts a proposal, and nothing lands until the
 * guardian's client posts here. The suite pins that contract:
 * - create / update / delete write what was submitted, not what was proposed
 * - the record surface never touches channels
 * - a guardian contact cannot be deleted through it
 * - a dismissal unblocks the parked call without writing
 * - every outcome resolves the parked call, so the CLI never hangs
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// ---------------------------------------------------------------------------
// Mock IPC so mirror ops + resolve_contact_prompt don't dial a real socket.
// ---------------------------------------------------------------------------

/**
 * Forms the daemon still has open. The gateway claims one before writing, and
 * the daemon grants that claim once, so the mock has to model the claim rather
 * than wave it through: most of what these tests pin is what happens on the
 * second answer to the same form.
 */
let openForms = new Set<string>();
const claimedForms = new Set<string>();

const ipcMock = mock(
  async (method: string, options?: { body?: Record<string, unknown> }) => {
    if (method === "contact_prompt_claim") {
      if (claimThrows) {
        throw new Error("socket closed");
      }
      const requestId = options?.body?.requestId as string;
      if (!openForms.has(requestId)) {
        return { claimed: false, reason: "unknown" };
      }
      if (claimedForms.has(requestId)) {
        return { claimed: false, reason: "already_claimed" };
      }
      claimedForms.add(requestId);
      return { claimed: true };
    }
    if (method === "resolve_contact_prompt" && resolveFailures > 0) {
      resolveFailures -= 1;
      throw new Error("socket closed");
    }
    if (method === "contacts_mirror_upsert_full") {
      if (mirrorWritesFail) {
        throw new Error("mirror unavailable");
      }
      const body = options?.body as
        { contactId?: string; notes?: string | null } | undefined;
      if (body?.contactId && body.notes !== undefined) {
        mirroredNotes.set(body.contactId, body.notes);
      }
      return { ok: true };
    }
    if (method === "contacts_info_batch") {
      const body = options?.body as { contactIds?: string[] } | undefined;
      return {
        infos: (body?.contactIds ?? [])
          .filter((id) => mirroredNotes.has(id))
          .map((id) => ({
            contactId: id,
            notes: mirroredNotes.get(id) ?? null,
            userFile: null,
            contactType: "human",
            assistantMetadata: null,
          })),
      };
    }
    return { resolved: true, exists: false };
  },
);

/** Open a form so a submission naming it can be claimed. */
function openForm(requestId: string): string {
  openForms.add(requestId);
  return requestId;
}

/** Make the next claim attempt fail the way an unreachable assistant does. */
let claimThrows = false;

/** How many resolve attempts fail before one is allowed through. */
let resolveFailures = 0;

/**
 * The assistant-side mirror, which is where notes actually live. Modelled
 * rather than stubbed away: a write that reports success without reaching it
 * is exactly the case worth testing.
 */
let mirroredNotes = new Map<string, string | null>();

/** Drop mirror writes, as an unreachable mirror op would. */
let mirrorWritesFail = false;

const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: ipcMock,
}));

// ---------------------------------------------------------------------------
// Imports that depend on the mocks above.
// ---------------------------------------------------------------------------

const { handleContactRecordSubmit } =
  await import("../http/routes/contact-prompt.js");
const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contactChannels: gwContactChannels, contacts: gwContacts } =
  await import("../db/schema.js");
const { eq } = await import("drizzle-orm");

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:7830/v1/contacts/record/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callsFor(op: string): { body: Record<string, unknown> }[] {
  return (ipcMock.mock.calls as unknown as unknown[][])
    .filter((c) => c[0] === op)
    .map((c) => c[1] as { body: Record<string, unknown> });
}

function resolveCall(): { body: Record<string, unknown> } {
  const calls = callsFor("resolve_contact_prompt");
  expect(calls).toHaveLength(1);
  return calls[0];
}

function seedChannel(contactId: string, type: string, address: string): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContactChannels)
    .values({
      id: `${contactId}-${type}`,
      contactId,
      type,
      address,
      isPrimary: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedContact(
  id: string,
  displayName: string,
  role: "contact" | "guardian" = "contact",
): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContacts)
    .values({ id, displayName, role, createdAt: now, updatedAt: now })
    .run();
}

beforeAll(async () => {
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  ipcMock.mockClear();
  openForms = new Set<string>();
  claimedForms.clear();
  claimThrows = false;
  resolveFailures = 0;
  mirroredNotes = new Map<string, string | null>();
  mirrorWritesFail = false;
  const gwDb = getGatewayDb();
  gwDb.delete(gwContactChannels).run();
  gwDb.delete(gwContacts).run();
});

describe("contact record submit", () => {
  test("create writes the submitted name and resolves the parked call", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-create"),
        operation: "create",
        displayName: "Alice",
        notes: "Dentist",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });

    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.displayName, "Alice"))
      .get();
    expect(row).toBeDefined();
    // Never a guardian, whatever the proposal said.
    expect(row!.role).toBe("contact");

    const resolved = resolveCall();
    expect(resolved.body.requestId).toBe("req-create");
    expect(resolved.body.contactId).toBe(row!.id);
  });

  test("notes that reach the mirror are reported as saved", async () => {
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-notes-ok"),
        operation: "create",
        displayName: "Alice",
        notes: "Dentist",
      }),
    );

    expect(resolveCall().body.notesSaved).toBe(true);
  });

  test("notes lost to a failed mirror write are reported as unsaved", async () => {
    // Notes live only in the mirror and that write is best-effort, so the name
    // can land while they do not. The command is told which it got rather than
    // being told everything worked.
    mirrorWritesFail = true;

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-notes-lost"),
        operation: "create",
        displayName: "Alice",
        notes: "Dentist",
      }),
    );

    expect(res.status).toBe(200);
    // The contact itself is in the gateway row, so it exists.
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    expect(resolveCall().body.notesSaved).toBe(false);
  });

  test("notes are unsaved when the mirror cannot be read back", async () => {
    // An unreadable mirror reports null info, which for a requested clear
    // looks exactly like success. Unknown is reported as not saved.
    mirrorWritesFail = true;

    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-notes-cleared"),
        operation: "create",
        displayName: "Alice",
        notes: "",
      }),
    );

    expect(resolveCall().body.notesSaved).toBe(false);
  });

  test("an update carrying only lost notes reports that nothing was written", async () => {
    seedContact("c-notes-only", "Alice");
    mirrorWritesFail = true;

    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-nothing-written"),
        operation: "update",
        contactId: "c-notes-only",
        notes: "Moved",
      }),
    );

    // The guardian submitted notes and nothing else, and they did not land.
    expect(resolveCall().body.nothingWritten).toBe(true);
  });

  test("an update that also renamed reports something written", async () => {
    seedContact("c-renamed", "Alice");
    mirrorWritesFail = true;

    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-something-written"),
        operation: "update",
        contactId: "c-renamed",
        displayName: "Alice Chen",
        notes: "Moved",
      }),
    );

    // The name is in the gateway row, so part of the submission landed.
    expect(resolveCall().body.nothingWritten).toBe(false);
  });

  test("a write with no notes says nothing about them", async () => {
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-no-notes"),
        operation: "create",
        displayName: "Alice",
      }),
    );

    expect(resolveCall().body.notesSaved).toBeUndefined();
  });

  test("create binds no channel", async () => {
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-no-channel"),
        operation: "create",
        displayName: "Alice",
      }),
    );

    expect(getGatewayDb().select().from(gwContactChannels).all()).toHaveLength(
      0,
    );
  });

  test("create writes the guardian's edit, not the proposed name", async () => {
    // The daemon proposed "Alice"; the guardian typed something else. Only the
    // submitted body reaches this route, which is the point of the form.
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-edited"),
        operation: "create",
        displayName: "Alice Chen",
      }),
    );

    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.displayName, "Alice Chen"))
        .get(),
    ).toBeDefined();
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.displayName, "Alice"))
        .get(),
    ).toBeUndefined();
  });

  test("the same create submitted twice lands one contact, not two", async () => {
    // The form is broadcast to every connected client, so two of them can
    // answer it, and a client that loses the response will retry.
    const body = {
      requestId: openForm("req-twice"),
      operation: "create",
      displayName: "Alice",
    };

    const first = await handleContactRecordSubmit(makeRequest(body));
    const second = await handleContactRecordSubmit(makeRequest(body));

    expect(first.status).toBe(200);
    // The loser is told it succeeded, because from its side nothing is wrong:
    // the form it was showing has been answered.
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ accepted: true, duplicate: true });
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
  });

  test("a second answer to an update form cannot overwrite the first", async () => {
    seedContact("c-race", "Alice");
    const requestId = openForm("req-race");

    await handleContactRecordSubmit(
      makeRequest({
        requestId,
        operation: "update",
        contactId: "c-race",
        displayName: "Alice Chen",
      }),
    );
    // A second client answers the same form with what it was seeded with.
    const second = await handleContactRecordSubmit(
      makeRequest({
        requestId,
        operation: "update",
        contactId: "c-race",
        displayName: "Alice",
      }),
    );

    expect(second.status).toBe(200);
    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "c-race"))
      .get();
    expect(row!.displayName).toBe("Alice Chen");
  });

  test("a submission for a form nobody is waiting on is refused", async () => {
    // Expired, or already resolved: the CLI has gone, so a write here would be
    // a contact nobody asked for.
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: "req-never-opened",
        operation: "create",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(409);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });

  test("two different forms create two contacts", async () => {
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-a"),
        operation: "create",
        displayName: "Alice",
      }),
    );
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-b"),
        operation: "create",
        displayName: "Alice",
      }),
    );

    // Same name, different forms: the guardian answered twice on purpose.
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(2);
  });

  test("a replayed create does not undo an edit made since", async () => {
    const body = {
      requestId: openForm("req-replay"),
      operation: "create",
      displayName: "Alice",
    };
    await handleContactRecordSubmit(makeRequest(body));
    const id = resolveCall().body.contactId as string;

    // The guardian renames the contact, and only then does a duplicate of the
    // original submission arrive.
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-rename"),
        operation: "update",
        contactId: id,
        displayName: "Alice Chen",
      }),
    );
    await handleContactRecordSubmit(makeRequest(body));

    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, id))
      .get();
    expect(row!.displayName).toBe("Alice Chen");
  });

  test("create requires a display name", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({ requestId: openForm("req-noname"), operation: "create" }),
    );

    expect(res.status).toBe(400);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
    // The parked call still learns it failed rather than waiting out the timeout.
    expect(resolveCall().body.error).toBeDefined();
  });

  test("update renames an existing contact and preserves its role", async () => {
    seedContact("c-1", "Alice");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-update"),
        operation: "update",
        contactId: "c-1",
        displayName: "Alice Chen",
      }),
    );

    expect(res.status).toBe(200);
    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "c-1"))
      .get();
    expect(row!.displayName).toBe("Alice Chen");
    expect(row!.role).toBe("contact");
  });

  test("update on an unknown id is a 404, not a stray contact", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-ghost"),
        operation: "update",
        contactId: "does-not-exist",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(404);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });

  test("an update naming no changed field writes nothing and still resolves", async () => {
    seedContact("c-noop", "Alice");

    // The card sends only what the guardian edited, so confirming a form
    // without touching it names neither field. That is "yes, as it stands",
    // not a bad request.
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-noop"),
        operation: "update",
        contactId: "c-noop",
      }),
    );

    expect(res.status).toBe(200);
    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "c-noop"))
      .get();
    expect(row!.displayName).toBe("Alice");
    expect(resolveCall().body.contactId).toBe("c-noop");
  });

  test("an update naming only notes leaves the name alone", async () => {
    seedContact("c-partial", "Alice");

    // Another client may have renamed this contact while the form was open;
    // echoing the form's stale name back would undo that.
    await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-partial"),
        operation: "update",
        contactId: "c-partial",
        notes: "Moved to Berlin",
      }),
    );

    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "c-partial"))
      .get();
    expect(row!.displayName).toBe("Alice");
  });

  test("an update cannot resurrect a contact deleted while the form was open", async () => {
    // No row to update: the write must not treat the explicit id as a create
    // and put back a channel-less contact somebody deliberately removed.
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-resurrect"),
        operation: "update",
        contactId: "c-gone",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(404);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });

  test("update requires a contact id", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-noid"),
        operation: "update",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(400);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });

  test("delete removes the contact and resolves the parked call", async () => {
    seedContact("c-2", "Alice");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-delete"),
        operation: "delete",
        contactId: "c-2",
      }),
    );

    expect(res.status).toBe(200);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-2"))
        .get(),
    ).toBeUndefined();
    expect(resolveCall().body.contactId).toBe("c-2");
  });

  test("delete refuses a contact that gained a channel while the form was open", async () => {
    seedContact("c-moved", "Alice");
    seedChannel("c-moved", "email", "alice@example.com");
    // An invite redeemed after the confirmation was built reparents a channel
    // onto this contact, which deleting would cascade away. It reads as a
    // channel the guardian never saw, whatever the contact row's timestamp
    // says, because reassignment does not touch that row.
    seedChannel("c-moved", "telegram", "12345");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-stale-delete"),
        operation: "delete",
        contactId: "c-moved",
        expectedChannels: [{ type: "email", address: "alice@example.com" }],
      }),
    );

    expect(res.status).toBe(409);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-moved"))
        .get(),
    ).toBeDefined();
  });

  test("delete proceeds when the channels are as the confirmation showed them", async () => {
    seedContact("c-unmoved", "Alice");
    seedChannel("c-unmoved", "email", "alice@example.com");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-fresh-delete"),
        operation: "delete",
        contactId: "c-unmoved",
        // Address case is not a change: the ACL keys channels case-insensitively.
        expectedChannels: [{ type: "email", address: "Alice@Example.com" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-unmoved"))
        .get(),
    ).toBeUndefined();
  });

  test("delete refuses the guardian contact", async () => {
    seedContact("g-1", "Owner", "guardian");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-delete-guardian"),
        operation: "delete",
        contactId: "g-1",
      }),
    );

    expect(res.status).toBe(403);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "g-1"))
        .get(),
    ).toBeDefined();
    expect(resolveCall().body.error).toBe("Cannot delete a guardian contact");
  });

  test("a refused delete leaves the mirror alone too", async () => {
    seedContact("c-atomic", "Alice");
    seedChannel("c-atomic", "email", "alice@example.com");
    seedChannel("c-atomic", "telegram", "12345");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-atomic"),
        operation: "delete",
        contactId: "c-atomic",
        expectedChannels: [{ type: "email", address: "alice@example.com" }],
      }),
    );

    expect(res.status).toBe(409);
    // The check runs with the gateway delete, before the mirror is touched, so
    // a refusal has removed nothing anywhere rather than half of it.
    expect(callsFor("contacts_mirror_delete_contact")).toHaveLength(0);
  });

  test("a dismissal resolves the parked call and writes nothing", async () => {
    seedContact("c-3", "Alice");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-cancel"),
        operation: "delete",
        contactId: "c-3",
        cancelled: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-3"))
        .get(),
    ).toBeDefined();
    expect(resolveCall().body.error).toBe("Cancelled by user");
  });

  test("a dismissal cannot cancel a submission that already has the claim", async () => {
    seedContact("c-dismiss", "Alice");
    const requestId = openForm("req-dismiss-race");

    // One client is mid-submit and holds the claim.
    await handleContactRecordSubmit(
      makeRequest({
        requestId,
        operation: "update",
        contactId: "c-dismiss",
        displayName: "Alice Chen",
      }),
    );

    // Another dismisses the same broadcast. Reporting "cancelled" here would
    // tell the caller nothing happened while the write was already committing.
    ipcMock.mockClear();
    const dismissed = await handleContactRecordSubmit(
      makeRequest({ requestId, cancelled: true }),
    );

    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toEqual({ accepted: true, duplicate: true });
    expect(callsFor("resolve_contact_prompt")).toHaveLength(0);
    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "c-dismiss"))
      .get();
    expect(row!.displayName).toBe("Alice Chen");
  });

  test("a dismissal that wins the claim blocks a later submission", async () => {
    seedContact("c-dismissed-first", "Alice");
    const requestId = openForm("req-dismissed-first");

    await handleContactRecordSubmit(
      makeRequest({ requestId, cancelled: true }),
    );
    expect(resolveCall().body.error).toBe("Cancelled by user");

    const late = await handleContactRecordSubmit(
      makeRequest({
        requestId,
        operation: "update",
        contactId: "c-dismissed-first",
        displayName: "Alice Chen",
      }),
    );

    expect(late.status).toBe(200);
    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "c-dismissed-first"))
      .get();
    expect(row!.displayName).toBe("Alice");
  });

  test("an unreachable assistant fails the submission rather than swallowing it", async () => {
    claimThrows = true;

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-unreachable"),
        operation: "create",
        displayName: "Alice",
      }),
    );

    // 503 rather than a duplicate-success: the client keeps its card, because
    // nothing reached the form and the command is still waiting.
    expect(res.status).toBe(503);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });

  test("an unreachable assistant fails a dismissal too", async () => {
    claimThrows = true;

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-cancel-unreachable"),
        cancelled: true,
      }),
    );

    expect(res.status).toBe(503);
    expect(callsFor("resolve_contact_prompt")).toHaveLength(0);
  });

  test("a committed write is reported even when the first callback fails", async () => {
    // The write has already happened, so a lost callback is a command told its
    // form failed over a contact that was created.
    resolveFailures = 1;

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-flaky-resolve"),
        operation: "create",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(200);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
    // Two attempts: the one that failed and the retry that landed.
    expect(callsFor("resolve_contact_prompt")).toHaveLength(2);
  });

  test("an unknown operation is rejected", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-bogus"),
        operation: "promote",
        contactId: "c-4",
      }),
    );

    expect(res.status).toBe(400);
    expect(callsFor("resolve_contact_prompt")).toHaveLength(0);
  });

  test("a missing requestId is rejected before any write", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({ operation: "create", displayName: "Alice" }),
    );

    expect(res.status).toBe(400);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(0);
  });
});

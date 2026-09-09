/**
 * Tests for POST /v1/contacts/record/submit.
 *
 * This is the write half of the guardian-confirmed contact form: the daemon
 * parks a CLI call and broadcasts a proposal, and nothing lands until the
 * guardian's client posts here. The suite pins that contract:
 * - create / update / delete write what was submitted, not what was proposed
 * - the record surface never touches channels, except a merge, which moves the
 *   donor's channels to the survivor
 * - a guardian contact cannot be deleted or merged away through it
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
  spyOn,
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
    if (method === "contacts_mirror_merge_contact" && mirrorMergeFails) {
      throw new Error("mirror unavailable");
    }
    if (method === "contacts_mirror_upsert_full") {
      if (mirrorWritesFail) {
        throw new Error("mirror unavailable");
      }
      const body = options?.body as
        | { contactId?: string; notes?: string | null }
        | undefined;
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

/**
 * Drop the merge's mirror op. The gateway half of a merge commits first, so
 * this is the window where the donor is gone here and still alive, notes and
 * all, on the assistant side.
 */
let mirrorMergeFails = false;

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
const { ContactStore } = await import("../db/contact-store.js");

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
  mirrorMergeFails = false;
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

  test("merge moves the donor's channels to the survivor and deletes the donor", async () => {
    seedContact("c-keep", "Alice");
    seedChannel("c-keep", "email", "alice@example.com");
    seedContact("c-donor", "Alice (work)");
    seedChannel("c-donor", "telegram", "12345");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge"),
        operation: "merge",
        contactId: "c-keep",
        donorContactId: "c-donor",
      }),
    );

    expect(res.status).toBe(200);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-donor"))
        .get(),
    ).toBeUndefined();
    const survivorChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.contactId, "c-keep"))
      .all();
    expect(survivorChannels.map((ch) => ch.type).sort()).toEqual([
      "email",
      "telegram",
    ]);

    const resolved = resolveCall();
    expect(resolved.body.contactId).toBe("c-keep");
    expect(resolved.body.merged).toBe(true);
  });

  test("a merge carrying a display name renames the survivor", async () => {
    seedContact("c-keep-named", "Alice");
    seedContact("c-donor-named", "Alice Chen");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-rename"),
        operation: "merge",
        contactId: "c-keep-named",
        donorContactId: "c-donor-named",
        displayName: "Alice Chen",
      }),
    );

    expect(res.status).toBe(200);
    const row = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "c-keep-named"))
      .get();
    expect(row!.displayName).toBe("Alice Chen");
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
  });

  test("a merge whose rename cannot land still reports the merge", async () => {
    seedContact("c-keep-gone", "Alice");
    seedContact("c-donor-gone", "Alice Chen");
    seedChannel("c-donor-gone", "email", "alice.chen@example.com");

    // The survivor disappears between the merge and the rename, which is the
    // window the rename's own transaction cannot cover.
    const originalMerge = ContactStore.prototype.mergeContacts;
    const spy = spyOn(
      ContactStore.prototype,
      "mergeContacts",
    ).mockImplementation(async function (
      this: InstanceType<typeof ContactStore>,
      keepId: string,
      mergeId: string,
    ) {
      const merged = await originalMerge.call(this, keepId, mergeId);
      getGatewayDb().delete(gwContacts).where(eq(gwContacts.id, keepId)).run();
      return merged;
    });

    try {
      const res = await handleContactRecordSubmit(
        makeRequest({
          requestId: openForm("req-merge-rename-gone"),
          operation: "merge",
          contactId: "c-keep-gone",
          donorContactId: "c-donor-gone",
          displayName: "Alice C",
        }),
      );

      // The donor is already gone, so reporting failure would describe a merge
      // that happened as one that did not.
      expect(res.status).toBe(200);
      const resolved = resolveCall();
      expect(resolved?.body.merged).toBe(true);
      expect(resolved?.body.renamed).toBe(false);
      expect(resolved?.body.error).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("a merge whose mirror op fails reports the half that did not land", async () => {
    seedContact("c-keep-mirror", "Alice");
    seedContact("c-donor-mirror", "Alice Chen");
    seedChannel("c-donor-mirror", "email", "alice.chen@example.com");
    mirrorMergeFails = true;

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-mirror"),
        operation: "merge",
        contactId: "c-keep-mirror",
        donorContactId: "c-donor-mirror",
      }),
    );

    // The gateway half committed, so this is a partial outcome, not a failure.
    expect(res.status).toBe(200);
    const resolved = resolveCall();
    expect(resolved.body.merged).toBe(true);
    expect(resolved.body.mirrored).toBe(false);
    expect(resolved.body.error).toBeUndefined();

    // Donor gone here, which is what leaves its notes stranded on the
    // assistant-side row the mirror op never reached.
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-donor-mirror"))
        .get(),
    ).toBeUndefined();
  });

  test("a merge whose mirror op lands says nothing about it", async () => {
    seedContact("c-keep-clean", "Alice");
    seedContact("c-donor-clean", "Alice Chen");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-clean"),
        operation: "merge",
        contactId: "c-keep-clean",
        donorContactId: "c-donor-clean",
      }),
    );

    expect(res.status).toBe(200);
    expect(resolveCall().body.mirrored).toBeUndefined();
  });

  test("merge refuses to absorb the guardian contact", async () => {
    seedContact("c-survivor", "Alice");
    seedContact("g-donor", "Owner", "guardian");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-guardian"),
        operation: "merge",
        contactId: "c-survivor",
        donorContactId: "g-donor",
        displayName: "Alice Chen",
      }),
    );

    // The store's own message, not a generic 500: the guardian can be the
    // survivor instead, and the command can say so.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      accepted: false,
      error:
        "Cannot merge away a guardian contact. Keep the guardian as the survivor instead.",
    });
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(2);
    // The submitted rename is part of the merge, so a refused merge leaves it
    // unwritten rather than renaming a contact that absorbed nobody.
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-survivor"))
        .get()!.displayName,
    ).toBe("Alice");
    expect(resolveCall().body.error).toBe(
      "Cannot merge away a guardian contact. Keep the guardian as the survivor instead.",
    );
  });

  test("merge naming an unknown donor is refused and writes nothing", async () => {
    seedContact("c-lonely", "Alice");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-ghost"),
        operation: "merge",
        contactId: "c-lonely",
        donorContactId: "does-not-exist",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      accepted: false,
      error: 'Contact "does-not-exist" not found',
    });
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);
  });

  test("merge without a donor is rejected before the form is claimed", async () => {
    seedContact("c-no-donor", "Alice");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-nodonor"),
        operation: "merge",
        contactId: "c-no-donor",
      }),
    );

    expect(res.status).toBe(400);
    // The form is still open, so the guardian can answer it properly.
    expect(callsFor("contact_prompt_claim")).toHaveLength(0);
    expect(callsFor("resolve_contact_prompt")).toHaveLength(0);
  });

  test("a merge carrying notes is rejected before the form is claimed", async () => {
    seedContact("c-keep", "Alice");
    seedContact("c-donor", "Alice C");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-notes"),
        operation: "merge",
        contactId: "c-keep",
        donorContactId: "c-donor",
        notes: "Same person",
      }),
    );

    // The merge combines both sets of notes, so accepting a submitted set
    // would either drop it or overwrite the combination.
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);
    expect(String(body.error)).toContain("combines both contacts' notes");
    expect(callsFor("contact_prompt_claim")).toHaveLength(0);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-donor"))
        .get(),
    ).toBeDefined();
  });

  test("a merge carrying an explicit notes clear is rejected too", async () => {
    seedContact("c-keep-null", "Alice");
    seedContact("c-donor-null", "Alice C");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-notes-null"),
        operation: "merge",
        contactId: "c-keep-null",
        donorContactId: "c-donor-null",
        notes: null,
      }),
    );

    expect(res.status).toBe(400);
    expect(callsFor("contact_prompt_claim")).toHaveLength(0);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-donor-null"))
        .get(),
    ).toBeDefined();
  });

  test("a merge renaming the survivor to blank is rejected before anything commits", async () => {
    seedContact("c-keep-blank", "Alice");
    seedContact("c-donor-blank", "Alice C");
    seedChannel("c-donor-blank", "email", "alice.c@example.com");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-blank-name"),
        operation: "merge",
        contactId: "c-keep-blank",
        donorContactId: "c-donor-blank",
        displayName: "   ",
      }),
    );

    // The rename runs after the merge commits, so accepting this would delete
    // the donor and then report the whole submission as failed.
    expect(res.status).toBe(400);
    expect(callsFor("contact_prompt_claim")).toHaveLength(0);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-donor-blank"))
        .get(),
    ).toBeDefined();
    const donorChannel = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.id, "c-donor-blank-email"))
      .get();
    expect(donorChannel?.contactId).toBe("c-donor-blank");
  });

  test("a merge of a contact with itself is rejected", async () => {
    seedContact("c-self", "Alice");

    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: openForm("req-merge-self"),
        operation: "merge",
        contactId: "c-self",
        donorContactId: "c-self",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      accepted: false,
      error: "Cannot merge a contact with itself",
    });
    expect(callsFor("contact_prompt_claim")).toHaveLength(0);
    expect(
      getGatewayDb()
        .select()
        .from(gwContacts)
        .where(eq(gwContacts.id, "c-self"))
        .get(),
    ).toBeDefined();
  });
});

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
    return { resolved: true, exists: false };
  },
);

/** Open a form so a submission naming it can be claimed. */
function openForm(requestId: string): string {
  openForms.add(requestId);
  return requestId;
}

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

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

const ipcMock = mock(async () => ({ resolved: true, exists: false }));

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
  ipcMock.mockImplementation(async () => ({ resolved: true, exists: false }));
  const gwDb = getGatewayDb();
  gwDb.delete(gwContactChannels).run();
  gwDb.delete(gwContacts).run();
});

describe("contact record submit", () => {
  test("create writes the submitted name and resolves the parked call", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: "req-create",
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
        requestId: "req-no-channel",
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
        requestId: "req-edited",
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
      requestId: "req-twice",
      operation: "create",
      displayName: "Alice",
    };

    const first = await handleContactRecordSubmit(makeRequest(body));
    const second = await handleContactRecordSubmit(makeRequest(body));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(1);

    // Both submissions report the same contact, so whichever reply the client
    // sees names the row that exists.
    const resolves = callsFor("resolve_contact_prompt");
    expect(resolves).toHaveLength(2);
    expect(resolves[0].body.contactId).toBe(resolves[1].body.contactId);
  });

  test("two different forms create two contacts", async () => {
    await handleContactRecordSubmit(
      makeRequest({
        requestId: "req-a",
        operation: "create",
        displayName: "Alice",
      }),
    );
    await handleContactRecordSubmit(
      makeRequest({
        requestId: "req-b",
        operation: "create",
        displayName: "Alice",
      }),
    );

    // Same name, different forms: the guardian answered twice on purpose.
    expect(getGatewayDb().select().from(gwContacts).all()).toHaveLength(2);
  });

  test("a replayed create does not undo an edit made since", async () => {
    const body = {
      requestId: "req-replay",
      operation: "create",
      displayName: "Alice",
    };
    await handleContactRecordSubmit(makeRequest(body));
    const id = resolveCall().body.contactId as string;

    // The guardian renames the contact, and only then does a duplicate of the
    // original submission arrive.
    await handleContactRecordSubmit(
      makeRequest({
        requestId: "req-rename",
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
      makeRequest({ requestId: "req-noname", operation: "create" }),
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
        requestId: "req-update",
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
        requestId: "req-ghost",
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
        requestId: "req-noid",
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
        requestId: "req-delete",
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
        requestId: "req-delete-guardian",
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
        requestId: "req-cancel",
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

  test("an unknown operation is rejected", async () => {
    const res = await handleContactRecordSubmit(
      makeRequest({
        requestId: "req-bogus",
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

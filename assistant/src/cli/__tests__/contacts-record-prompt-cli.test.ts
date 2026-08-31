/**
 * Tests for what `contacts create` / `update` / `delete` put in front of the
 * guardian.
 *
 * The form is seeded from these bodies and the guardian submits what it shows,
 * so a field the CLI leaves empty is a field the guardian unknowingly writes
 * over. That makes the request body, not just the eventual write, the thing
 * worth pinning.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CONTACT_FORM_SETTLE_MS } from "../../util/contact-form-timeouts.js";

interface IpcCall {
  operationId: string;
  options?: Record<string, unknown>;
  /** Transport options, where the socket deadline lives. */
  callOptions?: { timeoutMs?: number };
}

let calls: IpcCall[] = [];

const contact = {
  id: "ct_1",
  displayName: "Alice",
  notes: "Dentist, referred by Bob",
  contactType: "human",
  createdAt: 0,
  updatedAt: 0,
  interactionCount: 0,
  channels: [
    {
      id: "ch_1",
      contactId: "ct_1",
      type: "email",
      address: "alice@example.com",
    },
  ],
};

/** What a contact with no notes actually looks like on the wire. */
const contactWithoutNotes = { ...contact, notes: null };

let contactForRead: Record<string, unknown> = contact;
/** Make the display readback fail, as a transient IPC hiccup would. */
let readFails = false;

/**
 * The ordinary answers. Held as a named function so `beforeEach` can put it
 * back: a test that installs its own implementation would otherwise leave it
 * in place for everything after it, since clearing a mock keeps the last
 * implementation.
 */
/** Whether the daemon reports the submitted notes as having reached storage. */
let notesSaved: boolean | undefined;
/** Whether the daemon reports that nothing the guardian submitted landed. */
let nothingWritten: boolean | undefined;

const baseIpcImplementation = async (
  operationId: string,
  options?: Record<string, unknown>,
  callOptions?: { timeoutMs?: number },
) => {
  calls.push({ operationId, options, callOptions });
  if (operationId === "getContact") {
    if (readFails) {
      // 404-shaped, as a gateway-backed read reports a contact it cannot see.
      return { ok: false, error: "Contact not found", statusCode: 404 };
    }
    return { ok: true, result: { ok: true, contact: contactForRead } };
  }
  return {
    ok: true,
    result: { ok: true, contactId: contact.id, notesSaved, nothingWritten },
  };
};

const cliIpcCallMock = mock(baseIpcImplementation);

const actualCliClient = await import("../../ipc/cli-client.js");
mock.module("../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: cliIpcCallMock,
}));

const { runAssistantCommand } = await import("./run-assistant-command.js");

function recordPromptBody(): Record<string, unknown> {
  const call = calls.find((c) => c.operationId === "contacts_record_prompt");
  expect(call).toBeDefined();
  return (call!.options as { body: Record<string, unknown> }).body;
}

describe("contacts record prompts", () => {
  beforeEach(() => {
    calls = [];
    contactForRead = contact;
    readFails = false;
    notesSaved = undefined;
    nothingWritten = undefined;
    // Global and sticky: the failure-path cases below set it, and a later test
    // asserting success would otherwise read their exit code as its own.
    // Cleared to 0 rather than undefined, which does not reset it.
    process.exitCode = 0;
    cliIpcCallMock.mockClear();
    cliIpcCallMock.mockImplementation(baseIpcImplementation);
  });

  test("a name-only update carries the notes the contact already has", async () => {
    await runAssistantCommand(
      "contacts",
      "update",
      "ct_1",
      "--name",
      "Alice Chen",
    );

    const body = recordPromptBody();
    expect(body.operation).toBe("update");
    expect(body.displayName).toBe("Alice Chen");
    // The form compares against what is stored, so it has to be told.
    expect(body.currentNotes).toBe("Dentist, referred by Bob");
    // Without this the form shows an empty notes box and the guardian submits
    // it, erasing the notes as a side effect of a rename.
    expect(body.notes).toBe("Dentist, referred by Bob");
    expect(body.currentDisplayName).toBe("Alice");
  });

  test("an explicit empty --notes stays empty, so clearing still works", async () => {
    await runAssistantCommand("contacts", "update", "ct_1", "--notes", "");

    expect(recordPromptBody().notes).toBe("");
  });

  test("--notes overrides the existing value", async () => {
    await runAssistantCommand(
      "contacts",
      "update",
      "ct_1",
      "--notes",
      "Moved to Berlin",
    );

    expect(recordPromptBody().notes).toBe("Moved to Berlin");
  });

  test("a contact with no notes still opens the form", async () => {
    // `notes` is nullable on the wire, and the daemon's schema takes a string
    // or nothing. Passing the null through would reject the request and the
    // guardian would never see a form.
    contactForRead = contactWithoutNotes;

    await runAssistantCommand(
      "contacts",
      "update",
      "ct_1",
      "--name",
      "Alice Chen",
    );

    const body = recordPromptBody();
    expect(body.notes).toBeUndefined();
    expect("notes" in body ? body.notes : undefined).not.toBeNull();
  });

  test("the requested timeout bounds the form, not just the socket", async () => {
    // A CLI that gave up first would report failure while the form stayed
    // open, and a later answer would write something the caller was told had
    // not happened.
    await runAssistantCommand(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--timeout",
      "1000",
    );

    const call = calls.find((c) => c.operationId === "contacts_record_prompt");
    const body = (call!.options as { body: Record<string, unknown> }).body;
    expect(body.timeoutMs).toBe(1000);
    // The socket has to outlast an answer arriving at the deadline, which
    // starts the settle window from there. Giving up sooner would report a
    // failure while the write went on to commit.
    expect(call!.callOptions?.timeoutMs).toBeGreaterThan(
      1000 + CONTACT_FORM_SETTLE_MS,
    );
  });

  test.each(["1e3", "100.5", "300000ms", "abc", "-5"])(
    "a timeout of %p is refused rather than partly parsed",
    async (raw) => {
      // parseInt takes a valid prefix, so "1e3" would otherwise become a 1ms
      // form: open and shut before anyone could answer it.
      await runAssistantCommand(
        "contacts",
        "create",
        "--name",
        "Alice",
        "--timeout",
        raw,
      );

      expect(
        calls.some((c) => c.operationId === "contacts_record_prompt"),
      ).toBe(false);
    },
  );

  test("a timeout past the ceiling is refused before the guardian is bothered", async () => {
    await runAssistantCommand(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--timeout",
      "99999999",
    );

    expect(calls.some((c) => c.operationId === "contacts_record_prompt")).toBe(
      false,
    );
  });

  test("a write still reports success when only the display readback fails", async () => {
    // The guardian has answered and the write is done. Exiting non-zero here
    // says otherwise, and a retried create makes a second contact.
    readFails = true;

    await runAssistantCommand("contacts", "create", "--name", "Alice");

    expect(calls.some((c) => c.operationId === "contacts_record_prompt")).toBe(
      true,
    );
    expect(process.exitCode).toBeFalsy();
  });

  test("an update that wrote nothing exits nonzero", async () => {
    // The guardian submits only what they changed, so a proposed name they
    // left at its stored value never reaches the write. Whether anything
    // landed is the gateway's to report, not this command's to infer.
    notesSaved = false;
    nothingWritten = true;

    await runAssistantCommand(
      "contacts",
      "update",
      "ct_1",
      "--name",
      "Alice",
      "--notes",
      "Moved",
    );

    expect(process.exitCode).toBe(1);
  });

  test("a rename that loses its notes still succeeds, since the rename landed", async () => {
    notesSaved = false;
    nothingWritten = false;

    await runAssistantCommand(
      "contacts",
      "update",
      "ct_1",
      "--name",
      "Alice Chen",
      "--notes",
      "Moved",
    );

    expect(process.exitCode).toBeFalsy();
  });

  test("create proposes only what was asked for", async () => {
    await runAssistantCommand("contacts", "create", "--name", "Alice");

    const body = recordPromptBody();
    expect(body.operation).toBe("create");
    expect(body.displayName).toBe("Alice");
    expect(body.contactId).toBeUndefined();
  });

  test("delete reads the contact first, so a bad id fails before the guardian sees a form", async () => {
    await runAssistantCommand("contacts", "delete", "ct_1");

    const body = recordPromptBody();
    expect(body.operation).toBe("delete");
    expect(body.contactId).toBe("ct_1");
    expect(body.currentDisplayName).toBe("Alice");
    // Two contacts can share a name, so the confirmation carries the channels
    // that identify this one and that the delete will take with it.
    expect(body.channels).toEqual([
      { type: "email", address: "alice@example.com" },
    ]);
    // The read comes first: the form names the contact it is about.
    expect(calls[0]!.operationId).toBe("getContact");
  });

  test("delete reaches the confirmation for a contact the read cannot see", async () => {
    // A dual-write gap leaves contacts in the assistant mirror that this
    // gateway-backed read misses. `contacts list --query` surfaces them and
    // the delete supports removing them, so refusing here would strand an id
    // the guardian can see.
    readFails = true;

    await runAssistantCommand("contacts", "delete", "ct_orphan");

    const body = recordPromptBody();
    expect(body.operation).toBe("delete");
    expect(body.contactId).toBe("ct_orphan");
    // Nothing to show but the id, and no channels to compare against.
    expect(body.channels).toEqual([]);
  });

  // The refusing side of that branch (an update against a contact the read
  // cannot see, or a delete for an id nothing knows about) has no test: it
  // ends in `exitFromIpcResult`, which calls `process.exit` and takes the test
  // runner with it.

  test("update refuses when neither --name nor --notes is given", async () => {
    await runAssistantCommand("contacts", "update", "ct_1");

    expect(calls.some((c) => c.operationId === "contacts_record_prompt")).toBe(
      false,
    );
  });
});

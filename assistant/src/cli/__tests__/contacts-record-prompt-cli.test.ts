/**
 * Tests for what `contacts create` / `update` / `delete` / `merge` put in
 * front of the guardian.
 *
 * The form is seeded from these bodies and the guardian submits what it shows,
 * so a field the CLI leaves empty is a field the guardian unknowingly writes
 * over. That makes the request body, not just the eventual write, the thing
 * worth pinning.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { GUARDIAN_FORM_SETTLE_MS } from "../../util/guardian-form-timeouts.js";
import { reportIpcFailureWithoutExiting } from "./run-assistant-command.js";

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

/** The duplicate a merge folds into `contact`. */
const donor = {
  id: "ct_2",
  displayName: "Bob",
  notes: null,
  contactType: "human",
  createdAt: 0,
  updatedAt: 0,
  interactionCount: 0,
  channels: [
    {
      id: "ch_2",
      contactId: "ct_2",
      type: "phone",
      address: "+15555550142",
    },
  ],
};

/** What `getContact` answers with, by id. An id it does not hold reads as 404. */
let contactsById: Record<string, Record<string, unknown>> = {};
/** Make every read fail, as a transient IPC hiccup would. */
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
/** Whether the guardian closed the form instead of answering it. */
let dismissed = false;
/** Whether a merge's survivor took the submitted name. Absent unless renamed. */
let renamed: boolean | undefined;
/** Whether a merge reached the assistant's own copy of the contacts. */
let mirrored: boolean | undefined;

const baseIpcImplementation = async (
  operationId: string,
  options?: Record<string, unknown>,
  callOptions?: { timeoutMs?: number },
) => {
  calls.push({ operationId, options, callOptions });
  if (operationId === "getContact") {
    const id = (options as { pathParams?: { id?: string } } | undefined)
      ?.pathParams?.id;
    const found = id === undefined ? undefined : contactsById[id];
    if (readFails || !found) {
      // 404-shaped, as a gateway-backed read reports a contact it cannot see.
      return { ok: false, error: "Contact not found", statusCode: 404 };
    }
    return { ok: true, result: { ok: true, contact: found } };
  }
  if (dismissed) {
    // The rail keeps the human-readable reason alongside the marker.
    return {
      ok: true,
      result: { ok: false, error: "Cancelled by user", cancelled: true },
    };
  }
  return {
    ok: true,
    result: {
      ok: true,
      contactId: contact.id,
      notesSaved,
      nothingWritten,
      renamed,
      mirrored,
    },
  };
};

const cliIpcCallMock = mock(baseIpcImplementation);

const actualCliClient = await import("../../ipc/cli-client.js");
mock.module("../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: cliIpcCallMock,
  exitFromIpcResult: reportIpcFailureWithoutExiting,
}));

const { runAssistantCommand, runAssistantCommandFull } =
  await import("./run-assistant-command.js");

function recordPromptBody(): Record<string, unknown> {
  const call = calls.find((c) => c.operationId === "contacts_record_prompt");
  expect(call).toBeDefined();
  return (call!.options as { body: Record<string, unknown> }).body;
}

describe("contacts record prompts", () => {
  beforeEach(() => {
    calls = [];
    contactsById = { ct_1: contact, ct_2: donor };
    readFails = false;
    notesSaved = undefined;
    nothingWritten = undefined;
    dismissed = false;
    renamed = undefined;
    mirrored = undefined;
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
    contactsById.ct_1 = contactWithoutNotes;

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
      1000 + GUARDIAN_FORM_SETTLE_MS,
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

  test("update refuses when neither --name nor --notes is given", async () => {
    await runAssistantCommand("contacts", "update", "ct_1");

    expect(calls.some((c) => c.operationId === "contacts_record_prompt")).toBe(
      false,
    );
  });

  describe("merge", () => {
    test("both contacts are read, and the form carries what moves", async () => {
      const { stdout } = await runAssistantCommandFull(
        "contacts",
        "merge",
        "ct_1",
        "ct_2",
      );

      // Both reads come first: the confirmation names the pair it is about,
      // so a bad id fails before the guardian sees anything.
      expect(calls.slice(0, 2).map((c) => c.operationId)).toEqual([
        "getContact",
        "getContact",
      ]);

      const body = recordPromptBody();
      expect(body.operation).toBe("merge");
      expect(body.contactId).toBe("ct_1");
      expect(body.currentDisplayName).toBe("Alice");
      expect(body.donorContactId).toBe("ct_2");
      expect(body.donorDisplayName).toBe("Bob");
      // The guardian confirms which access moves, not just which ids, and the
      // card lists the survivor's own channels beside it: two contacts can
      // share a name, so the addresses are what tell them apart.
      expect(body.donorChannels).toEqual([
        { type: "phone", address: "+15555550142" },
      ]);
      expect(body.channels).toEqual([
        { type: "email", address: "alice@example.com" },
      ]);
      // No name is proposed, so the survivor keeps its own.
      expect(body.displayName).toBeUndefined();
      // A merge reparents channels rather than cascading them away, so there
      // is nothing for a staleness guard to protect.
      expect(body.expectedChannels).toBeUndefined();

      expect(stdout).toContain('Merged "Bob" into "Alice"');
      expect(process.exitCode).toBeFalsy();
    });

    test("--keep-donor-name proposes the donor's name for the survivor", async () => {
      await runAssistantCommand(
        "contacts",
        "merge",
        "ct_1",
        "ct_2",
        "--keep-donor-name",
      );

      expect(recordPromptBody().displayName).toBe("Bob");
    });

    test("merging a contact with itself is refused before any form", async () => {
      const { stderr } = await runAssistantCommandFull(
        "contacts",
        "merge",
        "ct_1",
        "ct_1",
      );

      expect(stderr).toContain("itself");
      expect(
        calls.some((c) => c.operationId === "contacts_record_prompt"),
      ).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    test("merging away the guardian is refused before any form", async () => {
      // The gateway refuses this, so opening the form would spend a
      // confirmation on a write that cannot land.
      contactsById = {
        ct_1: contact,
        ct_2: { ...donor, role: "guardian" },
      };

      const { stderr } = await runAssistantCommandFull(
        "contacts",
        "merge",
        "ct_1",
        "ct_2",
      );

      expect(stderr).toContain("guardian");
      expect(stderr).toContain("assistant contacts merge ct_2 ct_1");
      expect(
        calls.some((c) => c.operationId === "contacts_record_prompt"),
      ).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    test("an unknown donor id fails before the guardian sees a form", async () => {
      await runAssistantCommandFull("contacts", "merge", "ct_1", "ct_missing");

      expect(
        calls.some((c) => c.operationId === "contacts_record_prompt"),
      ).toBe(false);
      expect(process.exitCode).toBe(2);
    });

    test("a merge whose rename could not land still reports the merge", async () => {
      // The merge committed. Reporting it as failed would invite a retry
      // against a donor that no longer exists.
      renamed = false;

      const { stdout, stderr } = await runAssistantCommandFull(
        "contacts",
        "merge",
        "ct_1",
        "ct_2",
        "--keep-donor-name",
      );

      expect(stdout).toContain('Merged "Bob" into "Alice"');
      expect(stderr).toContain("not renamed");
      expect(process.exitCode).toBeFalsy();
    });

    test("a merge the assistant's own copy did not get still reports the merge", async () => {
      // The gateway half committed and the donor is gone from it, so a failure
      // here would describe a merge that happened as one that did not.
      mirrored = false;

      const { stdout, stderr } = await runAssistantCommandFull(
        "contacts",
        "merge",
        "ct_1",
        "ct_2",
      );

      expect(stdout).toContain('Merged "Bob" into "Alice"');
      expect(stderr).toContain("not cleaned up");
      expect(stderr).toContain("notes were not combined");
      expect(process.exitCode).toBeFalsy();
    });

    test("--json reports the surviving contact and the uncleaned copy", async () => {
      mirrored = false;

      const { stdout } = await runAssistantCommandFull(
        "contacts",
        "merge",
        "ct_1",
        "ct_2",
        "--json",
      );

      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        contact,
        mirrored: false,
      });
      expect(process.exitCode).toBeFalsy();
    });

    test("--json reports the surviving contact and the lost rename", async () => {
      renamed = false;

      const { stdout } = await runAssistantCommandFull(
        "contacts",
        "merge",
        "ct_1",
        "ct_2",
        "--keep-donor-name",
        "--json",
      );

      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        contact,
        renamed: false,
      });
    });
  });

  describe("a dismissed form", () => {
    const operations: [string, string[]][] = [
      ["create", ["contacts", "create", "--name", "Alice"]],
      ["update", ["contacts", "update", "ct_1", "--name", "Alice Chen"]],
      ["delete", ["contacts", "delete", "ct_1"]],
      ["merge", ["contacts", "merge", "ct_1", "ct_2"]],
    ];

    test.each(operations)(
      "%s reports it as a clean exit",
      async (_op, argv) => {
        // Nothing was written and nothing failed, so an error envelope here
        // would read as a write that went wrong.
        dismissed = true;

        const { stdout, stderr } = await runAssistantCommandFull(...argv);

        expect(stdout).toContain("Cancelled: nothing was written");
        expect(stderr).toBe("");
        expect(process.exitCode).toBe(130);
      },
    );

    test.each(operations)(
      "%s --json emits one object carrying the marker",
      async (_op, argv) => {
        dismissed = true;

        const { stdout, stderr } = await runAssistantCommandFull(
          ...argv,
          "--json",
        );

        // Parsing the whole of stdout is the assertion that it is one object:
        // a second would make this throw.
        expect(JSON.parse(stdout)).toEqual({ ok: true, cancelled: true });
        expect(stderr).toBe("");
        expect(process.exitCode).toBe(130);
      },
    );
  });
});

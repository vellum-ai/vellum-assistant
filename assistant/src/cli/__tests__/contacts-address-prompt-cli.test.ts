/**
 * Tests for the commands that open an address form, `contacts prompt`,
 * `contacts channels add` and `contacts create --channel`: what they put in
 * front of the guardian, and how they report the answer that comes back.
 *
 * The form is seeded from the request body and the guardian submits what it
 * shows, so the body is pinned here alongside the outcomes the commands have to
 * tell apart: a bind, a dismissal, and a genuine failure.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { reportIpcFailureWithoutExiting } from "./run-assistant-command.js";

interface IpcCall {
  operationId: string;
  options?: Record<string, unknown>;
  /** Transport options, where the socket deadline lives. */
  callOptions?: { timeoutMs?: number };
}

let calls: IpcCall[] = [];

/** What the daemon returns once the guardian has filled the form in. */
const boundChannel = {
  ok: true,
  channelType: "email",
  address: "alice@example.com",
  channelId: "ch_1",
  contactId: "ct_1",
  verified: true,
};

/** The dismissal shape: the marker, and the reason that reads alongside it. */
const dismissal = { ok: false, error: "Cancelled by user", cancelled: true };

/** The contact `channels add` targets, as `getContact` reads it back. */
const contact = {
  id: "ct_1",
  displayName: "Alice",
  contactType: "human",
  createdAt: 0,
  updatedAt: 0,
  interactionCount: 0,
  channels: [],
};

/** What `contacts_prompt` answers with. */
let promptResult: Record<string, unknown> = boundChannel;
/** Whether `getContact` can see the id the command was given. */
let contactExists = true;
/**
 * Who the address lookup reports. `address` is the address that contact
 * actually holds; it defaults to the queried one, since the search matches a
 * substring and can return a contact holding something longer.
 */
let addressHolders: Array<{
  id: string;
  displayName: string;
  address?: string;
}> = [];

/**
 * The ordinary answers. Held as a named function so `beforeEach` can put it
 * back: a test that installs its own implementation would otherwise leave it
 * in place for everything after it, since clearing a mock keeps the last
 * implementation.
 */
const baseIpcImplementation = async (
  operationId: string,
  options?: Record<string, unknown>,
  callOptions?: { timeoutMs?: number },
) => {
  calls.push({ operationId, options, callOptions });
  if (operationId === "getContact") {
    if (!contactExists) {
      // 404-shaped, as the gateway-backed read reports an id it cannot see.
      return { ok: false, error: "Contact not found", statusCode: 404 };
    }
    return { ok: true, result: { ok: true, contact } };
  }
  if (operationId === "listContacts") {
    const query =
      (options?.queryParams as {
        channelAddress?: string;
        channelType?: string;
      }) ?? {};
    return {
      ok: true,
      result: {
        ok: true,
        contacts: addressHolders.map((holder) => ({
          ...holder,
          channels: [
            {
              type: query.channelType ?? "email",
              address: holder.address ?? query.channelAddress ?? "",
            },
          ],
        })),
      },
    };
  }
  return { ok: true, result: promptResult };
};

const cliIpcCallMock = mock(baseIpcImplementation);

const actualCliClient = await import("../../ipc/cli-client.js");
mock.module("../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: cliIpcCallMock,
  exitFromIpcResult: reportIpcFailureWithoutExiting,
}));

const { runAssistantCommandFull } = await import("./run-assistant-command.js");

function addressPromptBody(): Record<string, unknown> {
  const call = calls.find((c) => c.operationId === "contacts_prompt");
  expect(call).toBeDefined();
  return (call!.options as { body: Record<string, unknown> }).body;
}

function wasCalled(operationId: string): boolean {
  return calls.some((c) => c.operationId === operationId);
}

beforeEach(() => {
  calls = [];
  promptResult = boundChannel;
  contactExists = true;
  addressHolders = [];
  // Global and sticky: the failure cases below set it, and a later test
  // asserting success would otherwise read their exit code as its own.
  // Cleared to 0 rather than undefined, which does not reset it.
  process.exitCode = 0;
  cliIpcCallMock.mockClear();
  cliIpcCallMock.mockImplementation(baseIpcImplementation);
});

describe("contacts address prompt", () => {
  test("the form is seeded with what the caller asked for", async () => {
    await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--channel",
      "email",
      "--label",
      "Work email",
      "--default-value",
      "alice@example.com",
      "--verify",
    );

    const body = addressPromptBody();
    expect(body.channel).toBe("email");
    expect(body.label).toBe("Work email");
    expect(body.defaultValue).toBe("alice@example.com");
    expect(body.verify).toBe(true);
    // An unstated role is a stated "unknown": the form seeds a role either way,
    // so leaving it off the body would let the daemon pick a different one.
    expect(body.role).toBe("unknown");
  });

  test("--verify is a proposal, so the reported status is the guardian's", async () => {
    promptResult = { ...boundChannel, verified: false };

    const { stdout } = await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--channel",
      "email",
      "--verify",
    );

    expect(stdout).toContain("Registered email channel: alice@example.com");
    expect(stdout).toContain("Status:     unverified");
    expect(process.exitCode).toBeFalsy();
  });

  test("a dismissal is a clean exit, not a failed bind", async () => {
    promptResult = dismissal;

    const { stdout, stderr } = await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--channel",
      "email",
    );

    expect(stdout).toContain("Cancelled: nothing was written");
    expect(stderr).toBe("");
    expect(process.exitCode).toBe(130);
  });

  test("a dismissal in --json emits one object carrying the marker", async () => {
    promptResult = dismissal;

    const { stdout, stderr } = await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--channel",
      "email",
      "--json",
    );

    // Parsing the whole of stdout is the assertion that it is one object: a
    // second would make this throw.
    expect(JSON.parse(stdout)).toEqual({ ok: true, cancelled: true });
    expect(stderr).toBe("");
    expect(process.exitCode).toBe(130);
  });

  test("--contact-id aims the form at that contact, not at the address", async () => {
    await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--contact-id",
      "ct_1",
      "--channel",
      "email",
    );

    // The read comes first: the form names the contact it is binding to.
    expect(calls[0]!.operationId).toBe("getContact");

    const body = addressPromptBody();
    expect(body.contactId).toBe("ct_1");
    expect(body.contactDisplayName).toBe("Alice");
    expect(body.label).toBe("Add email channel for Alice");
    // The target is fixed by the id, so the role hint has nothing to select.
    expect(body.role).toBeUndefined();
  });

  test("--contact-id and --role guardian are refused before any form opens", async () => {
    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--contact-id",
      "ct_1",
      "--role",
      "guardian",
      "--channel",
      "email",
    );

    expect(calls).toHaveLength(0);
    expect(stderr).toContain("--contact-id");
    expect(stderr).toContain("--role guardian");
    expect(process.exitCode).toBe(1);
  });

  test("a targeted bind warns when the pre-filled address looks taken", async () => {
    addressHolders = [{ id: "ct_2", displayName: "Bob" }];

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--contact-id",
      "ct_1",
      "--channel",
      "email",
      "--default-value",
      "bob@example.com",
    );

    expect(stderr).toContain('already bound to "Bob" (ct_2)');
    expect(wasCalled("contacts_prompt")).toBe(true);
    expect(process.exitCode).toBeFalsy();
  });

  test("an untargeted prompt has no contact to check the address against", async () => {
    await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--channel",
      "email",
      "--default-value",
      "alice@example.com",
    );

    expect(wasCalled("getContact")).toBe(false);
    expect(wasCalled("listContacts")).toBe(false);
    expect(addressPromptBody().contactId).toBeUndefined();
  });

  test("a form that failed still reports an error and exits nonzero", async () => {
    promptResult = { ok: false, error: "Channel resolution failed" };

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "prompt",
      "--channel",
      "email",
    );

    expect(stderr).toContain("Channel resolution failed");
    expect(process.exitCode).toBe(1);
  });
});

describe("contacts create --channel", () => {
  test("the create and the channel bind are one address form", async () => {
    await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--notes",
      "Dentist",
      "--channel",
      "email",
      "--address",
      "alice@example.com",
    );

    const body = addressPromptBody();
    expect(body.displayName).toBe("Alice");
    expect(body.notes).toBe("Dentist");
    expect(body.channel).toBe("email");
    expect(body.defaultValue).toBe("alice@example.com");
    // A proposed name and a target contact contradict each other, and the
    // daemon refuses the pair: this form creates the contact it names.
    expect(body.contactId).toBeUndefined();
    // One form, so the record form is never opened.
    expect(wasCalled("contacts_record_prompt")).toBe(false);
  });

  test("--verify proposes the attest", async () => {
    await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--channel",
      "email",
      "--verify",
    );

    expect(addressPromptBody().verify).toBe(true);
  });

  test("notes the mirror never took are reported, and the bind still stands", async () => {
    promptResult = { ...boundChannel, notesSaved: false };

    const { stdout, stderr } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--notes",
      "Dentist",
      "--channel",
      "email",
      "--address",
      "alice@example.com",
    );

    expect(stdout).toContain("Registered email channel: alice@example.com");
    expect(stderr).toContain(
      "The contact and channel were saved, but its notes were not",
    );
    // The contact and the channel are written, so this is a partial outcome
    // rather than a failed command.
    expect(process.exitCode).toBeFalsy();
  });

  test("notes a write says nothing about are reported as unconfirmed", async () => {
    // A gateway older than notesSaved ignores the parked notes and reports no
    // field, which would otherwise read as a clean save.
    promptResult = { ...boundChannel };

    const { stdout, stderr } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--notes",
      "Dentist",
      "--channel",
      "email",
      "--address",
      "alice@example.com",
    );

    expect(stdout).toContain("Registered email channel: alice@example.com");
    expect(stderr).toContain("did not confirm its notes");
    expect(process.exitCode).toBeFalsy();
  });

  test("--json carries the unconfirmed notes as null, not as a clean save", async () => {
    // Agents read this output, so a write that said nothing about the notes
    // must not come back looking like one that stored them.
    promptResult = { ...boundChannel };

    const { stdout } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--notes",
      "Dentist",
      "--channel",
      "email",
      "--json",
    );

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.notesSaved).toBeNull();
  });

  test("a create proposing no notes says nothing about them", async () => {
    promptResult = { ...boundChannel };

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--channel",
      "email",
    );

    expect(stderr).toBe("");
  });

  test("saved notes are reported by saying nothing about them", async () => {
    promptResult = { ...boundChannel, notesSaved: true };

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--notes",
      "Dentist",
      "--channel",
      "email",
    );

    expect(stderr).toBe("");
    expect(process.exitCode).toBeFalsy();
  });

  test("without --channel the record form is still what opens", async () => {
    await runAssistantCommandFull("contacts", "create", "--name", "Alice");

    expect(wasCalled("contacts_record_prompt")).toBe(true);
    expect(wasCalled("contacts_prompt")).toBe(false);
  });

  test("--address without --channel is refused, naming both flags", async () => {
    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--address",
      "alice@example.com",
    );

    expect(calls).toHaveLength(0);
    expect(stderr).toContain("--address");
    expect(stderr).toContain("--channel");
    expect(process.exitCode).toBe(1);
  });

  test("--verify without --channel is refused, naming both flags", async () => {
    // The record form has no verify field, so accepting this would create a
    // channel-less contact while reporting the flag as honored.
    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--name",
      "Alice",
      "--verify",
    );

    expect(calls).toHaveLength(0);
    expect(stderr).toContain("--verify");
    expect(stderr).toContain("--channel");
    expect(process.exitCode).toBe(1);
  });

  test("--channel without --name is refused: the contact needs a name", async () => {
    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "create",
      "--channel",
      "email",
    );

    expect(calls).toHaveLength(0);
    expect(stderr).toContain("--channel");
    expect(stderr).toContain("--name");
    expect(process.exitCode).toBe(1);
  });
});

describe("contacts channels add", () => {
  test("the form is aimed at the named contact", async () => {
    await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
      "--address",
      "alice@example.com",
    );

    // The read comes first: the form names the contact it is binding to.
    expect(calls[0]!.operationId).toBe("getContact");

    const body = addressPromptBody();
    expect(body.contactId).toBe("ct_1");
    expect(body.contactDisplayName).toBe("Alice");
    expect(body.channel).toBe("email");
    expect(body.defaultValue).toBe("alice@example.com");
    expect(body.label).toBe("Add email channel for Alice");
    // The target is fixed by the id, so the role hint has nothing to select.
    expect(body.role).toBeUndefined();
  });

  test("--verify proposes the attest", async () => {
    await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
      "--verify",
    );

    expect(addressPromptBody().verify).toBe(true);
  });

  test("an unknown contact id fails before the guardian sees a form", async () => {
    contactExists = false;

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_missing",
      "--channel",
      "email",
    );

    expect(wasCalled("contacts_prompt")).toBe(false);
    expect(stderr).toContain('Contact "ct_missing" not found');
    // The id came from somewhere, so the failure has to say where to get a
    // good one.
    expect(stderr).toContain("assistant contacts list");
  });

  test("an address another contact holds is flagged, and the form still opens", async () => {
    // This search reads the assistant mirror, so a stale row must not block a
    // bind the gateway would accept. The gateway is what refuses.
    addressHolders = [{ id: "ct_2", displayName: "Bob" }];

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
      "--address",
      "bob@example.com",
    );

    expect(stderr).toContain('already bound to "Bob" (ct_2)');
    expect(stderr).toContain("assistant contacts merge");
    expect(wasCalled("contacts_prompt")).toBe(true);
    expect(process.exitCode).toBeFalsy();
  });

  test("a bind that lands on a different contact is reported as a failure", async () => {
    // An older gateway ignores the target and resolves by address, which is the
    // duplicate this command exists to avoid. It answers ok, so the returned id
    // is the only evidence.
    promptResult = {
      ok: true,
      channelType: "email",
      address: "alice@example.com",
      channelId: "ch_9",
      contactId: "ct_other",
      verified: false,
    };

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
    );

    expect(stderr).toContain("ct_other");
    expect(stderr).toContain("older than this CLI");
    expect(process.exitCode).toBe(1);
  });

  test("a contact holding a longer address is not flagged", async () => {
    // The lookup matches a substring, so binding bob@example.com can return a
    // contact holding bobby@example.com. Warning on that would name a stranger
    // and point at an irreversible merge.
    addressHolders = [
      { id: "ct_2", displayName: "Bobby", address: "bobby@example.com" },
    ];

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
      "--address",
      "bob@example.com",
    );

    expect(stderr).toBe("");
    expect(wasCalled("contacts_prompt")).toBe(true);
  });

  test("a phone number written differently is still flagged", async () => {
    // The gateway canonicalizes before its own check, so a raw comparison here
    // would open a form the gateway then refuses.
    addressHolders = [
      { id: "ct_2", displayName: "Bob", address: "+12125550100" },
    ];

    const { stderr } = await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "phone",
      "--address",
      "(212) 555-0100",
    );

    expect(stderr).toContain('already bound to "Bob" (ct_2)');
  });

  test("an address the target already holds is not a conflict", async () => {
    addressHolders = [{ id: "ct_1", displayName: "Alice" }];

    await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
      "--address",
      "alice@example.com",
    );

    expect(wasCalled("contacts_prompt")).toBe(true);
    expect(process.exitCode).toBeFalsy();
  });

  test("no --address means nothing to pre-check", async () => {
    await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
    );

    expect(wasCalled("listContacts")).toBe(false);
    expect(addressPromptBody().defaultValue).toBeUndefined();
  });

  test("a dismissal is a clean exit, not a failed bind", async () => {
    promptResult = dismissal;

    const { stdout, stderr } = await runAssistantCommandFull(
      "contacts",
      "channels",
      "add",
      "ct_1",
      "--channel",
      "email",
    );

    expect(stdout).toContain("Cancelled: nothing was written");
    expect(stderr).toBe("");
    expect(process.exitCode).toBe(130);
  });
});

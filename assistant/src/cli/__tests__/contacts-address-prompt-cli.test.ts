/**
 * Tests for the two commands that open an address form, `contacts prompt` and
 * `contacts channels add`: what they put in front of the guardian, and how they
 * report the answer that comes back.
 *
 * The form is seeded from the request body and the guardian submits what it
 * shows, so the body is pinned here alongside the outcomes the commands have to
 * tell apart: a bind, a dismissal, and a genuine failure.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
/** Who the address lookup reports as already holding the address. */
let addressHolders: Array<{ id: string; displayName: string }> = [];

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
    return { ok: true, result: { ok: true, contacts: addressHolders } };
  }
  return { ok: true, result: promptResult };
};

const cliIpcCallMock = mock(baseIpcImplementation);

const actualCliClient = await import("../../ipc/cli-client.js");
mock.module("../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: cliIpcCallMock,
  // The real one ends the process, which would take the test runner with it.
  // Same stderr line and same exit code, and the caller carries on to its own
  // early return.
  exitFromIpcResult: (r: { error?: string; statusCode?: number }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = actualCliClient.exitCodeFromIpcResult(r);
  },
}));

const { runAssistantCommandFull } = await import("./run-assistant-command.js");

function addressPromptBody(): Record<string, unknown> {
  const call = calls.find((c) => c.operationId === "contacts_prompt");
  expect(call).toBeDefined();
  return (call!.options as { body: Record<string, unknown> }).body;
}

function promptWasOpened(): boolean {
  return calls.some((c) => c.operationId === "contacts_prompt");
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

    expect(promptWasOpened()).toBe(false);
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
    expect(promptWasOpened()).toBe(true);
    expect(process.exitCode).toBeFalsy();
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

    expect(promptWasOpened()).toBe(true);
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

    expect(calls.some((c) => c.operationId === "listContacts")).toBe(false);
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

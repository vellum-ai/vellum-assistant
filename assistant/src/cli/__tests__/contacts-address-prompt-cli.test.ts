/**
 * Tests for `contacts prompt`: what it puts in front of the guardian, and how
 * it reports the answer that comes back.
 *
 * The form is seeded from the request body and the guardian submits what it
 * shows, so the body is pinned here alongside the outcomes the command has to
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

/** What `contacts_prompt` answers with. */
let promptResult: Record<string, unknown> = boundChannel;

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
  return { ok: true, result: promptResult };
};

const cliIpcCallMock = mock(baseIpcImplementation);

const actualCliClient = await import("../../ipc/cli-client.js");
mock.module("../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: cliIpcCallMock,
}));

const { runAssistantCommandFull } = await import("./run-assistant-command.js");

function addressPromptBody(): Record<string, unknown> {
  const call = calls.find((c) => c.operationId === "contacts_prompt");
  expect(call).toBeDefined();
  return (call!.options as { body: Record<string, unknown> }).body;
}

describe("contacts address prompt", () => {
  beforeEach(() => {
    calls = [];
    promptResult = boundChannel;
    // Global and sticky: the failure case below sets it, and a later test
    // asserting success would otherwise read its exit code as its own.
    // Cleared to 0 rather than undefined, which does not reset it.
    process.exitCode = 0;
    cliIpcCallMock.mockClear();
    cliIpcCallMock.mockImplementation(baseIpcImplementation);
  });

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
    expect(process.exitCode).toBeFalsy();
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
    expect(process.exitCode).toBeFalsy();
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

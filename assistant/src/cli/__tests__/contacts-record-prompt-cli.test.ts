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

interface IpcCall {
  operationId: string;
  options?: Record<string, unknown>;
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

const cliIpcCallMock = mock(
  async (operationId: string, options?: Record<string, unknown>) => {
    calls.push({ operationId, options });
    if (operationId === "getContact") {
      return { ok: true, result: { ok: true, contact } };
    }
    return { ok: true, result: { ok: true, contactId: contact.id } };
  },
);

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
    cliIpcCallMock.mockClear();
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

  test("update refuses when neither --name nor --notes is given", async () => {
    await runAssistantCommand("contacts", "update", "ct_1");

    expect(calls.some((c) => c.operationId === "contacts_record_prompt")).toBe(
      false,
    );
  });
});

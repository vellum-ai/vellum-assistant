/**
 * Tests for the `assistant contacts` CLI command.
 *
 * Validates:
 *   - Subcommand routing for list, get, merge, upsert, channels update-status,
 *     invites list/create/revoke/redeem
 *   - Correct operation IDs and parameter shapes passed to cliIpcCall
 *   - JSON and plain output modes
 *   - Validation errors (invalid JSON channels, missing status/policy)
 *   - IPC error propagation via exitFromIpcResult
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** All `cliIpcCall` invocations captured for assertions. */
let ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];

/** Queue of responses for cliIpcCall. Each call pops from the front. */
let mockResponses: Array<{
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
}> = [];

/** Whether exitFromIpcResult was called. */
let exitFromIpcResultCalled = false;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return mockResponses.shift() ?? { ok: true, result: null };
  },
  exitFromIpcResult: (r: { ok: false; error?: string; statusCode?: number }, _cmd?: unknown) => {
    exitFromIpcResultCalled = true;
    process.exitCode = 1;
    // Don't actually exit in tests — just mark that it was called
    throw new Error(`exitFromIpcResult: ${r.error ?? "error"}`);
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerContactsCommand } = await import("../contacts.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerContactsCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  mockResponses = [];
  exitFromIpcResultCalled = false;
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// contacts list
// ---------------------------------------------------------------------------

describe("contacts list", () => {
  test("calls cliIpcCall(listContacts) and renders output", async () => {
    mockResponses.push({
      ok: true,
      result: {
        contacts: [
          { id: "c1", displayName: "Alice", role: "contact", contactType: "human", channels: [] },
        ],
      },
    });

    const { exitCode, stdout } = await runCommand(["contacts", "list"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("listContacts");
    expect(stdout).toContain("Alice");
    expect(stdout).toContain("1 contact(s)");
  });

  test("--role guardian passes queryParams.role", async () => {
    mockResponses.push({
      ok: true,
      result: { contacts: [] },
    });

    await runCommand(["contacts", "list", "--role", "guardian"]);

    expect(ipcCalls[0].method).toBe("listContacts");
    expect((ipcCalls[0].params!.queryParams as Record<string, unknown>).role).toBe("guardian");
  });

  test("--query alice passes queryParams.query", async () => {
    mockResponses.push({
      ok: true,
      result: { contacts: [] },
    });

    await runCommand(["contacts", "list", "--query", "alice"]);

    expect(ipcCalls[0].method).toBe("listContacts");
    expect((ipcCalls[0].params!.queryParams as Record<string, unknown>).query).toBe("alice");
  });

  test("--json outputs structured JSON", async () => {
    mockResponses.push({
      ok: true,
      result: {
        contacts: [
          { id: "c1", displayName: "Alice", role: "contact", contactType: "human", channels: [] },
        ],
      },
    });

    const { exitCode, stdout } = await runCommand(["contacts", "list", "--json"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.contacts)).toBe(true);
    expect(parsed.contacts[0].id).toBe("c1");
  });

  test("empty result shows 'No contacts found.'", async () => {
    mockResponses.push({
      ok: true,
      result: { contacts: [] },
    });

    const { stdout } = await runCommand(["contacts", "list"]);
    expect(stdout).toContain("No contacts found.");
  });

  test("IPC error calls exitFromIpcResult", async () => {
    mockResponses.push({ ok: false, error: "daemon not running", statusCode: 503 });

    const { exitCode } = await runCommand(["contacts", "list"]);
    expect(exitCode).toBe(1);
    expect(exitFromIpcResultCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// contacts get
// ---------------------------------------------------------------------------

describe("contacts get", () => {
  test("calls cliIpcCall(getContact) with pathParams.id", async () => {
    mockResponses.push({
      ok: true,
      result: {
        contact: {
          id: "abc-123",
          displayName: "Alice",
          role: "contact",
          contactType: "human",
          channels: [],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          interactionCount: 0,
        },
      },
    });

    const { exitCode } = await runCommand(["contacts", "get", "abc-123"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("getContact");
    expect(ipcCalls[0].params).toEqual({ pathParams: { id: "abc-123" } });
  });

  test("IPC error calls exitFromIpcResult", async () => {
    mockResponses.push({ ok: false, error: "not found", statusCode: 404 });

    const { exitCode } = await runCommand(["contacts", "get", "missing-id"]);
    expect(exitCode).toBe(1);
    expect(exitFromIpcResultCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// contacts merge
// ---------------------------------------------------------------------------

describe("contacts merge", () => {
  test("calls cliIpcCall(merge_contacts) with body { keepId, mergeId }", async () => {
    mockResponses.push({
      ok: true,
      result: {
        contact: {
          id: "keep-id",
          displayName: "Alice",
          role: "contact",
          contactType: "human",
          channels: [],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          interactionCount: 0,
        },
      },
    });

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "merge",
      "keep-id",
      "merge-id",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("merge_contacts");
    expect(ipcCalls[0].params).toEqual({ body: { keepId: "keep-id", mergeId: "merge-id" } });
    expect(stdout).toContain("Merged merge-id into keep-id");
  });
});

// ---------------------------------------------------------------------------
// contacts upsert
// ---------------------------------------------------------------------------

describe("contacts upsert", () => {
  test("--display-name Alice sends correct body (contactId undefined)", async () => {
    mockResponses.push({
      ok: true,
      result: {
        contact: {
          id: "new-id",
          displayName: "Alice",
          role: "contact",
          contactType: "human",
          channels: [],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          interactionCount: 0,
        },
      },
    });

    const { exitCode } = await runCommand([
      "contacts",
      "upsert",
      "--display-name",
      "Alice",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("upsert_contact");
    const body = ipcCalls[0].params!.body as Record<string, unknown>;
    expect(body.displayName).toBe("Alice");
    expect(body.contactId).toBeUndefined();
  });

  test("--display-name Alice --id existing-id sets body.contactId", async () => {
    mockResponses.push({
      ok: true,
      result: {
        contact: {
          id: "existing-id",
          displayName: "Alice",
          role: "contact",
          contactType: "human",
          channels: [],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          interactionCount: 0,
        },
      },
    });

    await runCommand([
      "contacts",
      "upsert",
      "--display-name",
      "Alice",
      "--id",
      "existing-id",
    ]);

    const body = ipcCalls[0].params!.body as Record<string, unknown>;
    expect(body.contactId).toBe("existing-id");
    expect(body.displayName).toBe("Alice");
  });

  test("--channels invalid-json exits with error, no IPC call", async () => {
    const { exitCode } = await runCommand([
      "contacts",
      "upsert",
      "--display-name",
      "Alice",
      "--channels",
      "not-json",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(0);
  });

  test("--channels non-array JSON exits with error, no IPC call", async () => {
    const { exitCode } = await runCommand([
      "contacts",
      "upsert",
      "--display-name",
      "Alice",
      "--channels",
      '{"type":"telegram"}',
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// contacts channels update-status
// ---------------------------------------------------------------------------

describe("contacts channels update-status", () => {
  test("no --status or --policy exits with error", async () => {
    const { exitCode } = await runCommand([
      "contacts",
      "channels",
      "update-status",
      "abc",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(0);
  });

  test("--status revoked --reason gone sends correct pathParams + body", async () => {
    mockResponses.push({
      ok: true,
      result: {
        channel: {
          id: "abc",
          contactId: "c1",
          type: "telegram",
          address: "12345",
          status: "revoked",
          policy: "allow",
        },
      },
    });

    const { exitCode } = await runCommand([
      "contacts",
      "channels",
      "update-status",
      "abc",
      "--status",
      "revoked",
      "--reason",
      "gone",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("updateContactChannel");
    expect(ipcCalls[0].params!.pathParams).toEqual({ contactChannelId: "abc" });
    const body = ipcCalls[0].params!.body as Record<string, unknown>;
    expect(body.status).toBe("revoked");
    expect(body.reason).toBe("gone");
  });
});

// ---------------------------------------------------------------------------
// contacts invites list
// ---------------------------------------------------------------------------

describe("contacts invites list", () => {
  test("calls cliIpcCall(invites_list) with empty queryParams", async () => {
    mockResponses.push({ ok: true, result: { invites: [] } });

    const { exitCode, stdout } = await runCommand(["contacts", "invites", "list"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("invites_list");
    expect(stdout).toContain("No invites found.");
  });

  test("--source-channel telegram passes queryParams.sourceChannel", async () => {
    mockResponses.push({ ok: true, result: { invites: [] } });

    await runCommand(["contacts", "invites", "list", "--source-channel", "telegram"]);

    expect((ipcCalls[0].params!.queryParams as Record<string, unknown>).sourceChannel).toBe("telegram");
  });

  test("renders invite list output", async () => {
    mockResponses.push({
      ok: true,
      result: {
        invites: [
          { id: "inv-1", sourceChannel: "telegram", status: "active", token: "tok-abc" },
        ],
      },
    });

    const { stdout } = await runCommand(["contacts", "invites", "list"]);
    expect(stdout).toContain("inv-1");
    expect(stdout).toContain("token:tok-abc");
    expect(stdout).toContain("1 invite(s)");
  });
});

// ---------------------------------------------------------------------------
// contacts invites create
// ---------------------------------------------------------------------------

describe("contacts invites create", () => {
  test("--source-channel telegram --contact-id cid sends correct body", async () => {
    mockResponses.push({
      ok: true,
      result: {
        invite: { id: "inv-new", sourceChannel: "telegram", token: "tok-xyz" },
      },
    });

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "invites",
      "create",
      "--source-channel",
      "telegram",
      "--contact-id",
      "cid",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("invites_create");
    const body = ipcCalls[0].params!.body as Record<string, unknown>;
    expect(body.sourceChannel).toBe("telegram");
    expect(body.contactId).toBe("cid");
    expect(stdout).toContain("Created invite inv-new");
    expect(stdout).toContain("Token: tok-xyz");
  });
});

// ---------------------------------------------------------------------------
// contacts invites revoke
// ---------------------------------------------------------------------------

describe("contacts invites revoke", () => {
  test("calls cliIpcCall(invites_revoke) with pathParams { id: inviteId }", async () => {
    mockResponses.push({
      ok: true,
      result: { invite: { id: "abc", status: "revoked" } },
    });

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "invites",
      "revoke",
      "abc",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("invites_revoke");
    expect(ipcCalls[0].params).toEqual({ pathParams: { id: "abc" } });
    expect(stdout).toContain("Revoked invite abc");
  });
});

// ---------------------------------------------------------------------------
// contacts invites redeem
// ---------------------------------------------------------------------------

describe("contacts invites redeem", () => {
  test("token-based: --token tok sends correct body", async () => {
    mockResponses.push({
      ok: true,
      result: { invite: { id: "inv-1", status: "redeemed" } },
    });

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "invites",
      "redeem",
      "--token",
      "tok",
      "--source-channel",
      "telegram",
      "--external-user-id",
      "123",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("invites_redeem");
    const body = ipcCalls[0].params!.body as Record<string, unknown>;
    expect(body.token).toBe("tok");
    expect(body.sourceChannel).toBe("telegram");
    expect(body.externalUserId).toBe("123");
    expect(stdout).toContain("Invite redeemed.");
  });

  test("voice-code: --code 123456 --caller-external-user-id +1555 sends correct body", async () => {
    mockResponses.push({
      ok: true,
      result: { type: "redeemed", memberId: "mem-1" },
    });

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "invites",
      "redeem",
      "--code",
      "123456",
      "--caller-external-user-id",
      "+1555",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls[0].method).toBe("invites_redeem");
    const body = ipcCalls[0].params!.body as Record<string, unknown>;
    expect(body.code).toBe("123456");
    expect(body.callerExternalUserId).toBe("+1555");
    expect(stdout).toContain("Redeemed (redeemed), member: mem-1");
  });

  test("voice-code --json includes inviteId when type=redeemed", async () => {
    mockResponses.push({
      ok: true,
      result: { type: "redeemed", memberId: "mem-1", inviteId: "inv-42" },
    });

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "invites",
      "redeem",
      "--code",
      "123456",
      "--caller-external-user-id",
      "+1555",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: true,
      type: "redeemed",
      memberId: "mem-1",
      inviteId: "inv-42",
    });
  });

  test("voice-code --json omits inviteId when type=already_member", async () => {
    mockResponses.push({
      ok: true,
      result: { type: "already_member", memberId: "mem-2" },
    });

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "invites",
      "redeem",
      "--code",
      "123456",
      "--caller-external-user-id",
      "+1555",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: true,
      type: "already_member",
      memberId: "mem-2",
    });
    expect(parsed).not.toHaveProperty("inviteId");
  });

  test("IPC error calls exitFromIpcResult", async () => {
    mockResponses.push({ ok: false, error: "invalid token", statusCode: 400 });

    const { exitCode } = await runCommand([
      "contacts",
      "invites",
      "redeem",
      "--token",
      "bad-tok",
    ]);

    expect(exitCode).toBe(1);
    expect(exitFromIpcResultCalled).toBe(true);
  });
});

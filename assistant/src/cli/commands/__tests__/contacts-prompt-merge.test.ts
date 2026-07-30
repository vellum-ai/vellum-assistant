/**
 * Tests for `assistant contacts prompt --merge-keep/--merge-discard`.
 *
 * Validates:
 *   - both merge flags are forwarded as mergeKeepId/mergeDiscardId
 *   - providing only one of the two flags fails before any IPC call
 *   - merge-mode success prints the surviving contact, not the
 *     address-entry "Registered channel" message
 *   - address-entry mode (no merge flags) is unaffected
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state — declared before importing the module under test
// ---------------------------------------------------------------------------

let mockIpcCallFn = mock(() => Promise.resolve({ ok: true, result: {} }));

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: mockIpcCallFn,
  exitFromIpcResult: mock((r: { error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 10;
  }),
}));

beforeEach(() => {
  mockIpcCallFn = mock(() => Promise.resolve({ ok: true, result: {} }));
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function runContactsCommand(...args: string[]) {
  mock.module("../../../ipc/cli-client.js", () => ({
    cliIpcCall: mockIpcCallFn,
    exitFromIpcResult: mock((r: { error?: string }) => {
      process.stderr.write((r.error ?? "Unknown error") + "\n");
      process.exitCode = 10;
    }),
  }));

  const { registerContactsCommand } = await import("../contacts.js");

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: (str: string) => stderrChunks.push(str),
      writeOut: () => {},
    });
    registerContactsCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    /* commander exit override throws */
  } finally {
    process.stdout.write = origWrite;
  }

  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

const KEEP_ID = "7a3b1c2d-4e5f-6789-abcd-ef0123456789";
const DISCARD_ID = "9c2f4a1b-3e5d-6789-abcd-ab9876543210";

describe("assistant contacts prompt --merge-keep/--merge-discard", () => {
  test("forwards mergeKeepId/mergeDiscardId to contacts_prompt", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          ok: true,
          contactId: KEEP_ID,
          contact: { id: KEEP_ID, displayName: "Alice" },
        },
      }),
    );

    await runContactsCommand(
      "contacts",
      "prompt",
      "--merge-keep",
      KEEP_ID,
      "--merge-discard",
      DISCARD_ID,
    );

    expect(mockIpcCallFn).toHaveBeenCalledTimes(1);
    const [method, payload] = mockIpcCallFn.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(method).toBe("contacts_prompt");
    expect(payload.body.mergeKeepId).toBe(KEEP_ID);
    expect(payload.body.mergeDiscardId).toBe(DISCARD_ID);
    expect(process.exitCode).toBe(0);
  });

  test("rejects when only --merge-keep is provided, without calling IPC", async () => {
    await runContactsCommand("contacts", "prompt", "--merge-keep", KEEP_ID);

    expect(mockIpcCallFn).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(0);
  });

  test("rejects when only --merge-discard is provided, without calling IPC", async () => {
    await runContactsCommand(
      "contacts",
      "prompt",
      "--merge-discard",
      DISCARD_ID,
    );

    expect(mockIpcCallFn).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(0);
  });

  test("merge success prints the surviving contact, not an address-registration message", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          ok: true,
          contactId: KEEP_ID,
          contact: { id: KEEP_ID, displayName: "Alice" },
        },
      }),
    );

    const { stdout } = await runContactsCommand(
      "contacts",
      "prompt",
      "--merge-keep",
      KEEP_ID,
      "--merge-discard",
      DISCARD_ID,
    );

    expect(stdout).toContain("Merged contact");
    expect(stdout).toContain("Alice");
    expect(stdout).not.toContain("Registered");
    expect(process.exitCode).toBe(0);
  });

  test("merge failure (e.g. guardian donor) surfaces the daemon error", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          ok: false,
          error: "Cannot merge away a guardian contact.",
        },
      }),
    );

    await runContactsCommand(
      "contacts",
      "prompt",
      "--merge-keep",
      KEEP_ID,
      "--merge-discard",
      DISCARD_ID,
    );

    expect(process.exitCode).not.toBe(0);
  });

  test("address-entry mode (no merge flags) is unaffected", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          ok: true,
          channelType: "email",
          address: "user@example.com",
          channelId: "ch-1",
          contactId: "ct-1",
        },
      }),
    );

    const { stdout } = await runContactsCommand(
      "contacts",
      "prompt",
      "--channel",
      "email",
    );

    expect(mockIpcCallFn).toHaveBeenCalledTimes(1);
    const [, payload] = mockIpcCallFn.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(payload.body.mergeKeepId).toBeUndefined();
    expect(payload.body.mergeDiscardId).toBeUndefined();
    expect(stdout).toContain("Registered email channel");
    expect(process.exitCode).toBe(0);
  });
});

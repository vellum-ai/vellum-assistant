/**
 * Tests for the email CLI subcommands that use the IPC transport.
 *
 * Validates:
 *   - register calls email_register with username param
 *   - send calls email_send with correct params (to/text/subject/cc/bcc/reply_to)
 *   - list calls email_list with correct filter params
 *   - status calls email_status
 *   - unregister calls email_unregister with --confirm
 *   - download calls email_download with messageId
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockIpcCallFn = mock(() =>
  Promise.resolve({ ok: true, result: {} }),
);

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: mockIpcCallFn,
  cliIpcCallStream: mock(() =>
    Promise.resolve({ ok: false, error: "not used" }),
  ),
  exitFromIpcResult: mock((r: { error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 10;
  }),
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIpcCallFn = mock(() => Promise.resolve({ ok: true, result: {} }));
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe("email register", () => {
  test("calls email_register with username param", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { address: "bot@vellum.me", id: "1", created_at: "2026-01-01" },
      }),
    );

    // Re-mock the module with new fn — bun mock.module is module-level so we
    // just verify the call via the captured mock
    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((r: { error?: string }) => {
        process.stderr.write((r.error ?? "Unknown error") + "\n");
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync(["node", "assistant", "email", "register", "mybot"]);

    expect(mockIpcCallFn).toHaveBeenCalledWith("email_register", { body: { username: "mybot" } });
  });

  test("--json outputs structured response", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { address: "bot@vellum.me", id: "1", created_at: "2026-01-01" },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((r: { error?: string }) => {
        process.stderr.write((r.error ?? "Unknown error") + "\n");
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({
        writeErr: () => {},
        writeOut: (str: string) => stdoutChunks.push(str),
      });
      registerEmailCmd(program);
      await program.parseAsync(["node", "assistant", "email", "--json", "register", "mybot"]);
    } catch {
      // commander may throw on exitOverride
    } finally {
      process.stdout.write = origWrite;
    }

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("bot@vellum.me");
  });

  test("propagates IPC error", async () => {
    const exitFromIpcResultMock = mock((r: { error?: string }) => {
      process.stderr.write((r.error ?? "Unknown error") + "\n");
      process.exitCode = 10;
    });

    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Daemon down",
        statusCode: undefined,
      }),
    ) as any;

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: exitFromIpcResultMock,
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);

    try {
      await program.parseAsync(["node", "assistant", "email", "register", "mybot"]);
    } catch {
      // may throw
    }

    expect(exitFromIpcResultMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

describe("email send", () => {
  test("calls email_send with to/text/subject params", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { delivery_id: "del_abc", status: "accepted" },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync([
      "node", "assistant",
      "email", "send", "user@example.com",
      "-s", "Hello",
      "-b", "Hi there",
    ]);

    expect(mockIpcCallFn).toHaveBeenCalledWith(
      "email_send",
      expect.objectContaining({
        body: expect.objectContaining({
          to: ["user@example.com"],
          subject: "Hello",
          text: "Hi there",
        }),
      }),
    );
  });

  test("includes cc/bcc when provided", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { delivery_id: "del_abc", status: "accepted" },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync([
      "node", "assistant",
      "email", "send", "user@example.com",
      "--cc", "cc@example.com",
      "--bcc", "bcc@example.com",
      "-s", "Test",
      "-b", "Body",
    ]);

    expect(mockIpcCallFn).toHaveBeenCalledWith(
      "email_send",
      expect.objectContaining({
        body: expect.objectContaining({
          cc: ["cc@example.com"],
          bcc: ["bcc@example.com"],
        }),
      }),
    );
  });

  test("reply_to param forwarded", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { delivery_id: "del_abc", status: "accepted" },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync([
      "node", "assistant",
      "email", "send", "user@example.com",
      "-s", "Re: Test",
      "-b", "Thanks!",
      "--reply-to", "msg_abc",
    ]);

    expect(mockIpcCallFn).toHaveBeenCalledWith(
      "email_send",
      expect.objectContaining({ body: expect.objectContaining({ reply_to: "msg_abc" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("email list", () => {
  test("calls email_list with no params when no filters", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { results: [], count: 0 },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync(["node", "assistant", "email", "list"]);

    expect(mockIpcCallFn).toHaveBeenCalledWith("email_list", { queryParams: { limit: "20" } });
  });

  test("passes direction param when --direction given", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { results: [], count: 0 },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync([
      "node", "assistant", "email", "list", "--direction", "inbound",
    ]);

    expect(mockIpcCallFn).toHaveBeenCalledWith(
      "email_list",
      expect.objectContaining({ queryParams: expect.objectContaining({ direction: "inbound" }) }),
    );
  });

  test("passes limit and since params", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { results: [], count: 0 },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync([
      "node", "assistant", "email", "list",
      "--limit", "5",
      "--since", "2026-01-01",
    ]);

    expect(mockIpcCallFn).toHaveBeenCalledWith(
      "email_list",
      expect.objectContaining({ queryParams: expect.objectContaining({ limit: "5", since: "2026-01-01" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("email status", () => {
  test("calls email_status", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          address: "bot@vellum.me",
          status: "active",
          created_at: "2026-01-01T00:00:00Z",
          usage: {
            sent_today: 1,
            daily_limit: 100,
            received_today: 0,
            sent_this_month: 5,
            received_this_month: 2,
          },
        },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync(["node", "assistant", "email", "status"]);

    expect(mockIpcCallFn).toHaveBeenCalledWith("email_status", {});
  });
});

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

describe("email unregister", () => {
  test("--confirm calls email_unregister", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { unregistered: "bot@vellum.me" },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerEmailCmd(program);
    await program.parseAsync([
      "node", "assistant", "email", "unregister", "--confirm",
    ]);

    expect(mockIpcCallFn).toHaveBeenCalledWith("email_unregister", {});
  });
});

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

describe("email download", () => {
  test("calls email_download with messageId", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "msg_1",
          from_address: "a@b.com",
          to_addresses: ["c@d.com"],
          subject: "Hi",
          body_text: "Hello",
          body_html: "<p>Hello</p>",
          in_reply_to: "",
          references: [],
          created_at: "2026-01-01T00:00:00Z",
          direction: "inbound",
        },
      }),
    );

    mock.module("../../../ipc/cli-client.js", () => ({
      cliIpcCall: mockIpcCallFn,
      cliIpcCallStream: mock(() =>
        Promise.resolve({ ok: false, error: "not used" }),
      ),
      exitFromIpcResult: mock((_r: { error?: string }) => {
        process.exitCode = 10;
      }),
    }));

    const { registerEmailCommand: registerEmailCmd } = await import("../email.js");

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({
        writeErr: () => {},
        writeOut: (str: string) => stdoutChunks.push(str),
      });
      registerEmailCmd(program);
      await program.parseAsync([
        "node", "assistant", "email", "download", "msg_1",
      ]);
    } catch {
      // may throw
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockIpcCallFn).toHaveBeenCalledWith(
      "email_download",
      { queryParams: { messageId: "msg_1" } },
    );
  });
});    

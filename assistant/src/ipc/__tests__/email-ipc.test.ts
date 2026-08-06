/**
 * Behavioral parity tests for the email CLI commands.
 *
 * Exercises the full IPC round-trip using a real AssistantIpcServer with a
 * mocked VellumPlatformClient. Validates that each email subcommand:
 *   - sends the correct HTTP request to the platform API
 *   - surfaces success responses to the CLI caller
 *   - surfaces platform errors to the CLI caller
 */

// Must be first — before any imports that resolve socket paths
delete process.env.ASSISTANT_IPC_SOCKET_DIR;

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { runAssistantCommandFull } from "../../cli/__tests__/run-assistant-command.js";
import { AssistantIpcServer } from "../assistant-server.js";

// ---------------------------------------------------------------------------
// Mock state — set up a controllable VellumPlatformClient at module boundary
// ---------------------------------------------------------------------------

let mockFetchFn: (
  path: string,
  init?: RequestInit,
) => Promise<Response> = async () =>
  new Response(JSON.stringify({}), { status: 200 });

const mockAssistantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

mock.module("../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => ({
      platformAssistantId: mockAssistantId,
      fetch: (path: string, init?: RequestInit) => mockFetchFn(path, init),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: AssistantIpcServer | null = null;

async function startServer(): Promise<void> {
  server = new AssistantIpcServer();
  await server.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(async () => {
  process.exitCode = 0;
  await startServer();
});

afterEach(() => {
  server?.stop();
  server = null;
  process.exitCode = 0;
  mockFetchFn = async () => new Response(JSON.stringify({}), { status: 200 });
});

// ---------------------------------------------------------------------------
// email register
// ---------------------------------------------------------------------------

test("register calls correct platform URL with username", async () => {
  let captured: { path: string; init?: RequestInit } | null = null;
  mockFetchFn = async (path, init) => {
    captured = { path, init };
    return new Response(
      JSON.stringify({
        id: "1",
        address: "mybot@example.com",
        created_at: "2026-01-01",
      }),
      { status: 201 },
    );
  };

  await runAssistantCommandFull("email", "register", "mybot");

  expect(captured).not.toBeNull();
  expect(captured!.path).toContain("/email-addresses/");
  expect(captured!.init?.method).toBe("POST");
  expect(JSON.parse(captured!.init?.body as string)).toEqual({
    username: "mybot",
  });
  expect(process.exitCode).toBe(0);
});

test("register --json outputs structured response", async () => {
  mockFetchFn = async () =>
    new Response(
      JSON.stringify({
        id: "1",
        address: "support@example.com",
        created_at: "2026-01-01",
      }),
      { status: 201 },
    );

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "register",
    "support",
  );

  const parsed = JSON.parse(stdout.trim());
  expect(parsed.address).toBe("support@example.com");
  expect(process.exitCode).toBe(0);
});

test("register: platform error surfaces to CLI", async () => {
  mockFetchFn = async () =>
    new Response(
      JSON.stringify({
        assistant_id: ["This assistant already has an email address."],
      }),
      { status: 400 },
    );

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "register",
    "mybot",
  );

  expect(process.exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toContain("already has an email address");
});

// ---------------------------------------------------------------------------
// email unregister
// ---------------------------------------------------------------------------

test("unregister --confirm calls delete on the registered address", async () => {
  let deleteCalled = false;
  mockFetchFn = async (path, init) => {
    if (path.includes("/email-addresses/") && !init?.method) {
      // list call
      return new Response(
        JSON.stringify({
          results: [{ id: "addr-1", address: "mybot@example.com" }],
        }),
        { status: 200 },
      );
    }
    if (init?.method === "DELETE") {
      deleteCalled = true;
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 200 });
  };

  const { stdout: _ } = await runAssistantCommandFull(
    "email",
    "unregister",
    "--confirm",
  );

  expect(deleteCalled).toBe(true);
  expect(process.exitCode).toBe(0);
});

test("unregister when no address registered → NotFoundError", async () => {
  mockFetchFn = async () =>
    new Response(JSON.stringify({ results: [] }), { status: 200 });

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "unregister",
    "--confirm",
  );

  expect(process.exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toContain("No email address registered");
});

// ---------------------------------------------------------------------------
// email status
// ---------------------------------------------------------------------------

test("status --json displays address and usage", async () => {
  const ADDR_ID = "addr-001";
  mockFetchFn = async (path) => {
    if (path.includes("/status/")) {
      return new Response(
        JSON.stringify({
          address: "mybot@example.com",
          status: "active",
          created_at: "2026-04-05T12:00:00Z",
          usage: {
            sent_today: 5,
            daily_limit: 100,
            received_today: 2,
            sent_this_month: 30,
            received_this_month: 12,
          },
        }),
        { status: 200 },
      );
    }
    // list call
    return new Response(
      JSON.stringify({
        results: [{ id: ADDR_ID, address: "mybot@example.com" }],
      }),
      { status: 200 },
    );
  };

  const { stdout } = await runAssistantCommandFull("email", "--json", "status");

  const parsed = JSON.parse(stdout.trim());
  expect(parsed.address).toBe("mybot@example.com");
  expect(parsed.usage.sent_today).toBe(5);
  expect(process.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// email list
// ---------------------------------------------------------------------------

test("list --json returns messages", async () => {
  const messages = [
    {
      id: "msg-001",
      direction: "inbound",
      from_address: "user@example.com",
      to_addresses: ["mybot@example.com"],
      subject: "Hello",
      created_at: "2026-04-05T12:00:00Z",
    },
  ];
  mockFetchFn = async () =>
    new Response(JSON.stringify({ results: messages, count: 1 }), {
      status: 200,
    });

  const { stdout } = await runAssistantCommandFull("email", "--json", "list");

  const parsed = JSON.parse(stdout.trim());
  expect(parsed.count).toBe(1);
  expect(parsed.results[0].subject).toBe("Hello");
  expect(process.exitCode).toBe(0);
});

test("list --direction passes filter to platform", async () => {
  let capturedPath = "";
  mockFetchFn = async (path) => {
    capturedPath = path;
    return new Response(JSON.stringify({ results: [], count: 0 }), {
      status: 200,
    });
  };

  await runAssistantCommandFull(
    "email",
    "--json",
    "list",
    "--direction",
    "inbound",
  );

  expect(capturedPath).toContain("direction=inbound");
  expect(process.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// email download
// ---------------------------------------------------------------------------

test("download --json returns full message", async () => {
  const message = {
    id: "msg-001",
    direction: "inbound",
    from_address: "user@example.com",
    to_addresses: ["mybot@example.com"],
    subject: "Hi",
    body_text: "Hello",
    body_html: "<p>Hello</p>",
    in_reply_to: "",
    references: [],
    created_at: "2026-04-05T12:00:00Z",
  };
  mockFetchFn = async () =>
    new Response(JSON.stringify(message), { status: 200 });

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "download",
    "msg-001",
  );

  const parsed = JSON.parse(stdout.trim());
  expect(parsed.id).toBe("msg-001");
  expect(process.exitCode).toBe(0);
});

test("download: not found returns error", async () => {
  mockFetchFn = async () =>
    new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "download",
    "msg-bad",
  );

  expect(process.exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toBeTruthy();
});

// ---------------------------------------------------------------------------
// email send
// ---------------------------------------------------------------------------

test("send --json returns delivery_id", async () => {
  mockFetchFn = async (path) => {
    if (path.includes("/email-addresses/")) {
      return new Response(
        JSON.stringify({
          results: [{ id: "addr-1", address: "mybot@example.com" }],
        }),
        { status: 200 },
      );
    }
    // send endpoint
    return new Response(
      JSON.stringify({ delivery_id: "del_abc123", status: "accepted" }),
      { status: 200 },
    );
  };

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "send",
    "user@example.com",
    "-s",
    "Test",
    "-b",
    "Hello",
  );

  const parsed = JSON.parse(stdout.trim());
  expect(parsed.delivery_id).toBe("del_abc123");
  expect(process.exitCode).toBe(0);
});

test("send --attach reads the file and forwards base64 attachments to the platform", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-attach-"));
  const filePath = join(dir, "report.pdf");
  const fileBytes = "pdf-bytes-here";
  writeFileSync(filePath, fileBytes);

  let sendBody: Record<string, unknown> | null = null;
  mockFetchFn = async (path, init) => {
    if (path.includes("/email-addresses/")) {
      return new Response(
        JSON.stringify({
          results: [{ id: "addr-1", address: "mybot@example.com" }],
        }),
        { status: 200 },
      );
    }
    // send endpoint — capture the forwarded payload
    sendBody = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({ delivery_id: "del_attach", status: "accepted" }),
      { status: 200 },
    );
  };

  try {
    await runAssistantCommandFull(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Report",
      "-b",
      "Attached",
      "--attach",
      filePath,
    );

    expect(sendBody).not.toBeNull();
    expect(sendBody!.attachments).toEqual([
      {
        filename: "report.pdf",
        content_type: "application/pdf",
        content: Buffer.from(fileBytes).toString("base64"),
      },
    ]);
    expect(process.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send with a missing --attach path fails without calling the platform", async () => {
  let sendCalled = false;
  mockFetchFn = async (path) => {
    if (path.includes("/email-addresses/")) {
      return new Response(
        JSON.stringify({
          results: [{ id: "addr-1", address: "mybot@example.com" }],
        }),
        { status: 200 },
      );
    }
    sendCalled = true;
    return new Response(
      JSON.stringify({ delivery_id: "x", status: "accepted" }),
      { status: 200 },
    );
  };

  await runAssistantCommandFull(
    "email",
    "--json",
    "send",
    "user@example.com",
    "-s",
    "Report",
    "-b",
    "Attached",
    "--attach",
    join(tmpdir(), "does-not-exist-xyz.pdf"),
  );

  expect(process.exitCode).not.toBe(0);
  expect(sendCalled).toBe(false);
});

test("send: 402 billing error surfaces", async () => {
  mockFetchFn = async (path) => {
    if (path.includes("/email-addresses/")) {
      return new Response(
        JSON.stringify({
          results: [{ id: "addr-1", address: "mybot@example.com" }],
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 402 });
  };

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "send",
    "user@example.com",
    "-s",
    "Test",
    "-b",
    "Body",
  );

  expect(process.exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toContain("balance");
});

// ---------------------------------------------------------------------------
// email attachment --list
// ---------------------------------------------------------------------------

test("attachment --list --json returns attachments", async () => {
  const atts = [
    {
      id: "att-001",
      filename: "file.pdf",
      content_type: "application/pdf",
      size_bytes: 100_000,
      content_id: "",
      created_at: "2026-04-05T12:00:00Z",
    },
  ];
  mockFetchFn = async () =>
    new Response(JSON.stringify({ results: atts }), { status: 200 });

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "attachment",
    "msg-001",
    "--list",
  );

  const parsed = JSON.parse(stdout.trim());
  expect(parsed.results).toHaveLength(1);
  expect(parsed.results[0].filename).toBe("file.pdf");
  expect(process.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// list-endpoint failure tests (platform 5xx must not masquerade as "no address")
// ---------------------------------------------------------------------------

test("unregister: list-endpoint 500 surfaces platform error", async () => {
  mockFetchFn = async () =>
    new Response(JSON.stringify({ detail: "Internal server error" }), {
      status: 500,
    });

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "unregister",
    "--confirm",
  );

  expect(process.exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toContain("500");
  expect(parsed.error).not.toContain("No email address registered");
});

test("status: list-endpoint 500 surfaces platform error", async () => {
  mockFetchFn = async () =>
    new Response(JSON.stringify({ detail: "Internal server error" }), {
      status: 500,
    });

  const { stdout } = await runAssistantCommandFull("email", "--json", "status");

  expect(process.exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toContain("500");
  expect(parsed.error).not.toContain("No email address registered");
});

test("send: list-endpoint 500 surfaces platform error", async () => {
  mockFetchFn = async () =>
    new Response(JSON.stringify({ detail: "Internal server error" }), {
      status: 500,
    });

  const { stdout } = await runAssistantCommandFull(
    "email",
    "--json",
    "send",
    "user@example.com",
    "-s",
    "Test",
    "-b",
    "Body",
  );

  expect(process.exitCode).not.toBe(0);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toContain("500");
  expect(parsed.error).not.toContain("No email address registered");
});

// ---------------------------------------------------------------------------
// daemon-down scenario
// ---------------------------------------------------------------------------

test("daemon-down scenario: no IPC server → exit 10", async () => {
  server?.stop();
  server = null;
  await new Promise((r) => setTimeout(r, 50));

  const { stdout } = await runAssistantCommandFull("email", "--json", "status");

  expect(process.exitCode).toBe(10);
  // JSON error should still be written to stdout in --json mode
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.error).toBeTruthy();
});

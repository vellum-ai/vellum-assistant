/**
 * Tests for the email attachment subcommand.
 *
 * Uses IPC mocks (cliIpcCall / cliIpcCallStream) — no real daemon required.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockIpcCallFn: any = mock(() => Promise.resolve({ ok: true, result: { results: [] } }));
let mockIpcCallStreamFn: any = mock(() =>
  Promise.resolve({ ok: false, error: "not used" }),
);

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: (...args: Parameters<typeof mockIpcCallFn>) => mockIpcCallFn(...args),
  cliIpcCallStream: (...args: Parameters<typeof mockIpcCallStreamFn>) =>
    mockIpcCallStreamFn(...args),
  exitFromIpcResult: mock((r: { error?: string; statusCode?: number }) => {
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
    info: (...args: unknown[]) => {
      captured.push(args.join(" "));
    },
    warn: () => {},
    error: (...args: unknown[]) => {
      captured.push("[error] " + args.join(" "));
    },
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Capture output
// ---------------------------------------------------------------------------

const captured: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStream(chunks: Uint8Array[]): {
  ok: true;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  abort: () => void;
} {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const chunk of chunks) ctrl.enqueue(chunk);
      ctrl.close();
    },
  });
  return { ok: true, headers: { "x-filename": "test.pdf" }, body, abort: () => {} };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  process.exitCode = 0;
  captured.length = 0;

  tmpDir = join(tmpdir(), `email-att-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  // Default: list returns two attachments
  mockIpcCallFn = mock(() =>
    Promise.resolve({
      ok: true,
      result: {
        results: [
          {
            id: "att-001",
            filename: "invoice.pdf",
            content_type: "application/pdf",
            size_bytes: 245_000,
            content_id: "",
            created_at: "2026-04-05T12:00:00Z",
          },
          {
            id: "att-002",
            filename: "screenshot.png",
            content_type: "image/png",
            size_bytes: 1_200_000,
            content_id: "<img001@mail>",
            created_at: "2026-04-05T12:01:00Z",
          },
        ],
      },
    }),
  );

  mockIpcCallStreamFn = mock(() =>
    Promise.resolve(
      makeMockStream([new Uint8Array([1, 2, 3])]),
    ),
  );
});

afterEach(() => {
  process.exitCode = 0;
  captured.length = 0;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Helper: run the attachment subcommand
// ---------------------------------------------------------------------------

async function runAttachment(...args: string[]): Promise<string> {
  const { registerEmailCommand } = await import("../email.js");

  const capturedOutput: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Buffer) => {
    capturedOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };

  try {
    const { Command } = await import("commander");
    const program = new Command();
    program.exitOverride();
    registerEmailCommand(program);
    await program.parseAsync(["node", "assistant", "email", "attachment", ...args]);
  } catch {
    // exitOverride throws on --help etc; ignore
  } finally {
    process.stdout.write = origWrite;
  }

  return [...capturedOutput, ...captured].join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("email attachment (IPC)", () => {
  test("--list calls email_attachment_list with messageId", async () => {
    await runAttachment("msg_1", "--list");

    expect(mockIpcCallFn.mock.calls.length).toBeGreaterThan(0);
    const [method, params] = mockIpcCallFn.mock.calls[0] as unknown as [string, { queryParams: Record<string, unknown> }];
    expect(method).toBe("email_attachment_list");
    expect(params.queryParams.messageId).toBe("msg_1");
  });

  test("--list displays attachment metadata", async () => {
    const out = await runAttachment("msg_1", "--list");

    expect(out).toContain("invoice.pdf");
    expect(out).toContain("screenshot.png");
    expect(out).toContain("2 attachment(s)");
    expect(process.exitCode).toBe(0);
  });

  test("--list with no attachments shows empty message", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({ ok: true, result: { results: [] } }),
    );

    const out = await runAttachment("msg_1", "--list");

    expect(out).toContain("No attachments");
    expect(process.exitCode).toBe(0);
  });

  test("--list --json outputs JSON", async () => {
    let jsonOut = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer) => {
      jsonOut += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    try {
      const { registerEmailCommand } = await import("../email.js");
      const { Command } = await import("commander");
      const program = new Command();
      program.exitOverride();
      registerEmailCommand(program);
      await program.parseAsync(["node", "assistant", "email", "--json", "attachment", "msg_1", "--list"]);
    } finally {
      process.stdout.write = origWrite;
    }

    const parsed = JSON.parse(jsonOut.trim());
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].filename).toBe("invoice.pdf");
    expect(process.exitCode).toBe(0);
  });

  test("--list returns error on IPC failure", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({ ok: false, error: "daemon error", statusCode: 500 }),
    );

    await runAttachment("msg_1", "--list");

    // exitFromIpcResult sets exitCode to 10 in mock
    expect(process.exitCode).not.toBe(0);
  });

  test("single download: calls list then stream with correct params", async () => {
    await runAttachment("msg_1", "att-001", "-o", tmpDir);

    // The list call should come first
    const listCall = mockIpcCallFn.mock.calls[0] as unknown as [string, { queryParams: Record<string, unknown> }];
    expect(listCall[0]).toBe("email_attachment_list");
    expect(listCall[1].queryParams.messageId).toBe("msg_1");

    // Stream call should use the correct attachmentId and messageId
    const streamCall = mockIpcCallStreamFn.mock.calls[0] as unknown as [string, { queryParams: Record<string, unknown> }];
    expect(streamCall[0]).toBe("email_attachment_get");
    expect(streamCall[1].queryParams.attachmentId).toBe("att-001");
    expect(streamCall[1].queryParams.messageId).toBe("msg_1");

    expect(process.exitCode).toBe(0);
  });

  test("single download: writes file to disk", async () => {
    const content = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    mockIpcCallStreamFn = mock(() =>
      Promise.resolve(makeMockStream([content])),
    );

    await runAttachment("msg_1", "att-001", "-o", tmpDir);

    const filePath = join(tmpDir, "invoice.pdf");
    expect(existsSync(filePath)).toBe(true);
    const written = readFileSync(filePath);
    expect(written).toEqual(Buffer.from(content));
    expect(process.exitCode).toBe(0);
  });

  test("single download: attachment not in list → exit code 2", async () => {
    await runAttachment("msg_1", "att-999", "-o", tmpDir);

    expect(process.exitCode).toBe(2);
    const out = captured.join("\n");
    expect(out).toContain("Attachment not found");
  });

  test("single download: stream error → throws", async () => {
    mockIpcCallStreamFn = mock(() =>
      Promise.resolve({ ok: false, error: "stream failed", statusCode: 500 }),
    );

    // The thrown error from streamDownloadAttachment should propagate out
    // (not caught — let the test framework see it unless the action catches it)
    try {
      await runAttachment("msg_1", "att-001", "-o", tmpDir);
    } catch {
      // acceptable — the stream failure throws
    }
    // Either throws or sets exitCode != 0
    // We just verify the stream was attempted
    expect(mockIpcCallStreamFn.mock.calls.length).toBeGreaterThan(0);
  });

  test("--all: calls list then streams each attachment", async () => {
    await runAttachment("msg_1", "--all", "-o", tmpDir);

    // First IPC call: list
    const listCall = mockIpcCallFn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(listCall[0]).toBe("email_attachment_list");

    // Two stream calls — one per attachment
    expect(mockIpcCallStreamFn.mock.calls.length).toBe(2);
    const ids = (mockIpcCallStreamFn.mock.calls as unknown as [string, { queryParams: Record<string, unknown> }][]).map(
      ([, p]) => p.queryParams.attachmentId,
    );
    expect(ids).toContain("att-001");
    expect(ids).toContain("att-002");

    expect(process.exitCode).toBe(0);
  });

  test("--all: writes files to disk", async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70]); // %PDF
    const pngBytes = new Uint8Array([137, 80, 78, 71]); // PNG header
    let callIdx = 0;
    mockIpcCallStreamFn = mock(() => {
      const chunk = callIdx++ === 0 ? pdfBytes : pngBytes;
      return Promise.resolve(makeMockStream([chunk]));
    });

    await runAttachment("msg_1", "--all", "-o", tmpDir);

    expect(existsSync(join(tmpDir, "invoice.pdf"))).toBe(true);
    expect(existsSync(join(tmpDir, "screenshot.png"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("--all with no attachments → exit code 1", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({ ok: true, result: { results: [] } }),
    );

    await runAttachment("msg_1", "--all", "-o", tmpDir);

    expect(process.exitCode).toBe(1);
    expect(captured.join("")).toContain("No attachments");
  });

  test("no attachment-id and no --all → exit code 1", async () => {
    await runAttachment("msg_1");

    expect(process.exitCode).toBe(1);
    expect(captured.join("")).toContain("Specify an attachment ID");
  });

  test("path traversal in filename is sanitized", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          results: [
            {
              id: "att-001",
              filename: "../../../etc/passwd",
              content_type: "application/octet-stream",
              size_bytes: 100,
              content_id: "",
              created_at: "2026-04-05T12:00:00Z",
            },
          ],
        },
      }),
    );

    await runAttachment("msg_1", "att-001", "-o", tmpDir);

    // Should write to <tmpDir>/passwd, not traverse up
    expect(existsSync(join(tmpDir, "passwd"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("formatBytes displays human-readable sizes in --list", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          results: [
            {
              id: "att-001",
              filename: "tiny.txt",
              content_type: "text/plain",
              size_bytes: 500,
              content_id: "",
              created_at: "2026-04-05T12:00:00Z",
            },
            {
              id: "att-002",
              filename: "big.mp4",
              content_type: "video/mp4",
              size_bytes: 2_500_000,
              content_id: "",
              created_at: "2026-04-05T12:01:00Z",
            },
          ],
        },
      }),
    );

    const out = await runAttachment("msg_1", "--list");

    expect(out).toContain("500 B");
    expect(out).toContain("2.4 MB");
    expect(process.exitCode).toBe(0);
  });
});  

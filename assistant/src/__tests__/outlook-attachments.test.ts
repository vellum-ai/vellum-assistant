import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../tools/types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockListAttachments = mock(() =>
  Promise.resolve({
    value: [
      {
        id: "att-1",
        name: "report.pdf",
        contentType: "application/pdf",
        size: 12345,
        isInline: false,
      },
      {
        id: "att-2",
        name: "logo.png",
        contentType: "image/png",
        size: 5678,
        isInline: true,
      },
    ],
  }),
);

const mockGetAttachment = mock(() =>
  Promise.resolve({
    id: "att-1",
    name: "report.pdf",
    contentType: "application/pdf",
    size: 12345,
    isInline: false,
    // "Hello World" in base64
    contentBytes: Buffer.from("Hello World").toString("base64"),
  }),
);

const mockResolveOAuthConnection = mock(() =>
  Promise.resolve({ id: "conn-1" }),
);

mock.module("../messaging/providers/outlook/client.js", () => ({
  listAttachments: mockListAttachments,
  getAttachment: mockGetAttachment,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

// Import after mocking
const { run } =
  await import("../config/bundled-skills/outlook/tools/outlook-attachments.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

let testDir: string;

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: testDir,
    conversationId: "test-conv",
    ...overrides,
  } as ToolContext;
}

beforeEach(async () => {
  testDir = join(tmpdir(), `outlook-attach-test-${Date.now()}`);
  await Bun.write(join(testDir, ".keep"), "");
  mockListAttachments.mockClear();
  mockGetAttachment.mockClear();
  mockResolveOAuthConnection.mockClear();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("outlook_attachments", () => {
  describe("validation", () => {
    test("returns error when action is missing", async () => {
      const result = await run({ message_id: "msg-1" }, makeContext());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("action is required");
    });

    test("returns error when message_id is missing", async () => {
      const result = await run({ action: "list" }, makeContext());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("message_id is required");
    });

    test("returns error for unknown action", async () => {
      const result = await run(
        { action: "delete", message_id: "msg-1" },
        makeContext(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown action");
    });
  });

  describe("list action", () => {
    test("lists attachments on a message", async () => {
      const result = await run(
        { action: "list", message_id: "msg-1" },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({
        attachmentId: "att-1",
        name: "report.pdf",
        contentType: "application/pdf",
        size: 12345,
        isInline: false,
      });
      expect(parsed[1]).toEqual({
        attachmentId: "att-2",
        name: "logo.png",
        contentType: "image/png",
        size: 5678,
        isInline: true,
      });
    });

    test("returns message when no attachments found", async () => {
      mockListAttachments.mockResolvedValueOnce({ value: [] });

      const result = await run(
        { action: "list", message_id: "msg-1" },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("No attachments found");
    });

    test("passes account to resolveOAuthConnection", async () => {
      await run(
        { action: "list", message_id: "msg-1", account: "user@outlook.com" },
        makeContext(),
      );

      expect(mockResolveOAuthConnection).toHaveBeenCalledWith("outlook", {
        account: "user@outlook.com",
      });
    });

    test("handles API errors gracefully", async () => {
      mockListAttachments.mockRejectedValueOnce(new Error("Unauthorized"));

      const result = await run(
        { action: "list", message_id: "msg-1" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unauthorized");
    });
  });

  describe("download action", () => {
    test("downloads and saves attachment to disk", async () => {
      const result = await run(
        {
          action: "download",
          message_id: "msg-1",
          attachment_id: "att-1",
        },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Attachment saved to");
      expect(result.content).toContain("report.pdf");
      expect(result.content).toContain("11 bytes");

      // Verify file contents
      const filePath = join(testDir, "report.pdf");
      const contents = await readFile(filePath, "utf-8");
      expect(contents).toBe("Hello World");
    });

    test("returns error when attachment_id is missing", async () => {
      const result = await run(
        { action: "download", message_id: "msg-1" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("attachment_id is required");
    });

    test("handles API errors during download", async () => {
      mockGetAttachment.mockRejectedValueOnce(new Error("Not Found"));

      const result = await run(
        {
          action: "download",
          message_id: "msg-1",
          attachment_id: "att-1",
        },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Not Found");
    });

    test("correctly decodes base64 content", async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      mockGetAttachment.mockResolvedValueOnce({
        id: "att-bin",
        name: "binary.dat",
        contentType: "application/octet-stream",
        size: 6,
        isInline: false,
        contentBytes: binaryContent.toString("base64"),
      });

      const result = await run(
        {
          action: "download",
          message_id: "msg-1",
          attachment_id: "att-bin",
        },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      const filePath = join(testDir, "binary.dat");
      const saved = await readFile(filePath);
      expect(Buffer.compare(saved, binaryContent)).toBe(0);
    });
  });

  describe("path traversal protection", () => {
    test("strips directory traversal from filename", async () => {
      mockGetAttachment.mockResolvedValueOnce({
        id: "att-evil",
        name: "../../../etc/passwd",
        contentType: "application/octet-stream",
        size: 5,
        isInline: false,
        contentBytes: Buffer.from("evil").toString("base64"),
      });

      const result = await run(
        {
          action: "download",
          message_id: "msg-1",
          attachment_id: "att-evil",
        },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      // basename("../../../etc/passwd") = "passwd", so file should be saved as "passwd"
      expect(result.content).toContain("passwd");
      expect(result.content).not.toContain("../");

      // Verify no file was written outside the working directory
      const filePath = join(testDir, "passwd");
      const contents = await readFile(filePath, "utf-8");
      expect(contents).toBe("evil");
    });

    test("strips embedded .. sequences from filename", async () => {
      mockGetAttachment.mockResolvedValueOnce({
        id: "att-dots",
        name: "safe..name..txt",
        contentType: "text/plain",
        size: 5,
        isInline: false,
        contentBytes: Buffer.from("dots").toString("base64"),
      });

      const result = await run(
        {
          action: "download",
          message_id: "msg-1",
          attachment_id: "att-dots",
        },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("safe");
    });
  });
});

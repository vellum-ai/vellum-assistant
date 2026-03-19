import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "history-render-test-")),
);

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getRootDir: () => testDir,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { renderHistoryContent } from "../daemon/handlers/shared.js";
import {
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe("renderHistoryContent", () => {
  test("renders text-only content unchanged", () => {
    const output = renderHistoryContent([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(output.text).toBe("hello world");
    expect(output.toolCalls).toEqual([]);
  });

  test("renders file attachments for attachment-only turns", () => {
    const output = renderHistoryContent([
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "application/pdf",
          filename: "spec.pdf",
          data: Buffer.from("hello").toString("base64"),
        },
        extracted_text: "Important requirement from the attachment.",
      },
    ]);

    expect(output.text).toContain("[File attachment] spec.pdf");
    expect(output.text).toContain("type=application/pdf");
    expect(output.text).toContain("size=5 B");
    expect(output.text).toContain(
      "Attachment text: Important requirement from the attachment.",
    );
  });

  test("skips image attachment placeholder text (images sent as separate attachments)", () => {
    const output = renderHistoryContent([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from("hello").toString("base64"),
        },
      },
    ]);

    expect(output.text).toBe("");
  });

  test("appends attachment lines after text content", () => {
    const output = renderHistoryContent([
      { type: "text", text: "please review the file" },
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/plain",
          filename: "notes.txt",
          data: Buffer.from("hello").toString("base64"),
        },
      },
    ]);

    expect(output.text).toContain(
      "please review the file\n[File attachment] notes.txt",
    );
  });

  test("falls back to string conversion for non-array content", () => {
    expect(renderHistoryContent("raw string").text).toBe("raw string");
    expect(renderHistoryContent(null).text).toBe("");
    expect(renderHistoryContent(undefined).text).toBe("");
    expect(renderHistoryContent(42).text).toBe("42");
  });

  test("preserves JSON object content as JSON string", () => {
    expect(renderHistoryContent({ foo: "bar" }).text).toBe('{"foo":"bar"}');
  });

  test("extracts tool_use blocks into toolCalls", () => {
    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "web_fetch",
        input: { url: "https://example.com" },
      },
    ]);

    expect(output.text).toBe("");
    expect(output.toolCalls).toEqual([
      { name: "web_fetch", input: { url: "https://example.com" } },
    ]);
    expect(output.toolCallsBeforeText).toBe(true);
  });

  test("pairs tool_result with matching tool_use by id", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "file1.txt\nfile2.txt",
        is_error: false,
      },
    ]);

    expect(output.toolCalls).toEqual([
      {
        name: "bash",
        input: { command: "ls" },
        result: "file1.txt\nfile2.txt",
        isError: false,
      },
    ]);
  });

  test("marks error tool results", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "bad" } },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "command not found",
        is_error: true,
      },
    ]);

    expect(output.toolCalls).toEqual([
      {
        name: "bash",
        input: { command: "bad" },
        result: "command not found",
        isError: true,
      },
    ]);
  });

  test("handles mixed text and tool blocks", () => {
    const output = renderHistoryContent([
      { type: "text", text: "Let me look that up." },
      {
        type: "tool_use",
        id: "tu_1",
        name: "web_fetch",
        input: { url: "https://example.com" },
      },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "page content here",
      },
    ]);

    expect(output.text).toBe("Let me look that up.");
    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls[0].name).toBe("web_fetch");
    expect(output.toolCalls[0].result).toBe("page content here");
    expect(output.toolCallsBeforeText).toBe(false);
  });

  test("sets toolCallsBeforeText true when tool_use precedes text", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "text", text: "Here are the files." },
    ]);

    expect(output.toolCallsBeforeText).toBe(true);
    expect(output.text).toBe("Here are the files.");
    expect(output.toolCalls).toHaveLength(1);
  });

  test("sets toolCallsBeforeText false when no tool calls exist", () => {
    const output = renderHistoryContent([{ type: "text", text: "Just text." }]);

    expect(output.toolCallsBeforeText).toBe(false);
  });

  test("handles orphan tool_result without matching tool_use", () => {
    const output = renderHistoryContent([
      { type: "tool_result", tool_use_id: "missing", content: "some result" },
    ]);

    expect(output.toolCalls).toEqual([
      { name: "unknown", input: {}, result: "some result", isError: false },
    ]);
  });

  test("produces textSegments for text-tool-text interleaving", () => {
    const output = renderHistoryContent([
      { type: "text", text: "What are you working on?" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "memory_manage",
        input: { key: "task" },
      },
      { type: "tool_result", tool_use_id: "tu_1", content: "saved" },
      { type: "text", text: "Saved that to memory." },
    ]);

    expect(output.textSegments).toEqual([
      "What are you working on?",
      "Saved that to memory.",
    ]);
    expect(output.contentOrder).toEqual(["text:0", "tool:0", "text:1"]);
  });

  test("produces single segment for text-only content", () => {
    const output = renderHistoryContent([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);

    expect(output.textSegments).toEqual(["Hello world"]);
    expect(output.contentOrder).toEqual(["text:0"]);
  });

  test("produces tool-only contentOrder for tool-only messages", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]);

    expect(output.textSegments).toEqual([]);
    expect(output.contentOrder).toEqual(["tool:0"]);
  });

  test("produces segments for tool-text pattern", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "text", text: "Here are the files." },
    ]);

    expect(output.textSegments).toEqual(["Here are the files."]);
    expect(output.contentOrder).toEqual(["tool:0", "text:0"]);
  });

  test("produces segments for text-tool-tool-text pattern", () => {
    const output = renderHistoryContent([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "tool_use", id: "tu_2", name: "bash", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "tu_2", content: "/home" },
      { type: "text", text: "Done." },
    ]);

    expect(output.textSegments).toEqual(["Let me check.", "Done."]);
    expect(output.contentOrder).toEqual([
      "text:0",
      "tool:0",
      "tool:1",
      "text:1",
    ]);
  });

  test("produces empty segments for non-array content", () => {
    const output = renderHistoryContent(null);
    expect(output.textSegments).toEqual([]);
    expect(output.contentOrder).toEqual([]);

    const output2 = renderHistoryContent("raw string");
    expect(output2.textSegments).toEqual(["raw string"]);
    expect(output2.contentOrder).toEqual(["text:0"]);
  });
});

describe("getAttachmentsForMessage", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  async function createMessage(role: string, content: string): Promise<string> {
    const conv = createConversation("test");
    const msg = await addMessage(conv.id, role, content);
    return msg.id;
  }

  test("returns attachments linked to a message", async () => {
    const msgId = await createMessage("assistant", "Here is a chart");
    const stored = uploadAttachment("chart.png", "image/png", "iVBORw==");
    linkAttachmentToMessage(msgId, stored.id, 0);

    const result = getAttachmentsForMessage(msgId);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(stored.id);
    expect(result[0].originalFilename).toBe("chart.png");
    expect(result[0].mimeType).toBe("image/png");
    expect(result[0].dataBase64).toBe("iVBORw==");
  });

  test("returns empty array when no attachments are linked", () => {
    expect(getAttachmentsForMessage("msg-nonexistent")).toEqual([]);
  });

  test("returns multiple attachments in position order", async () => {
    const msgId = await createMessage("assistant", "Two files");
    const a1 = uploadAttachment("first.txt", "text/plain", "AAAA");
    const a2 = uploadAttachment("second.txt", "text/plain", "BBBB");

    linkAttachmentToMessage(msgId, a2.id, 1);
    linkAttachmentToMessage(msgId, a1.id, 0);

    const result = getAttachmentsForMessage(msgId);
    expect(result).toHaveLength(2);
    expect(result[0].originalFilename).toBe("first.txt");
    expect(result[1].originalFilename).toBe("second.txt");
  });

  test("returns all attachments linked to a message", async () => {
    const msgId = await createMessage("assistant", "Mixed");
    const a1 = uploadAttachment("a.png", "image/png", "AAAA");
    const a2 = uploadAttachment("b.png", "image/png", "BBBB");

    linkAttachmentToMessage(msgId, a1.id, 0);
    linkAttachmentToMessage(msgId, a2.id, 1);

    const result = getAttachmentsForMessage(msgId);
    expect(result).toHaveLength(2);
  });
});

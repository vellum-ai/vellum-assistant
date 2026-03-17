import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";

const testDir = mkdtempSync(join(tmpdir(), "asset-materialize-test-"));
const sandboxDir = join(testDir, "sandbox");

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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  }),
}));

import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { assetMaterializeTool } from "../tools/assets/materialize.js";
import type { ToolContext } from "../tools/types.js";

initializeDb();

// Ensure the sandbox directory exists
import { mkdirSync } from "node:fs";
mkdirSync(sandboxDir, { recursive: true });

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

const dummyContext: ToolContext = {
  workingDir: sandboxDir,
  conversationId: "conv-test",
  trustClass: "guardian",
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("AssetMaterializeTool input validation", () => {
  test("returns error when attachment_id is missing", async () => {
    const result = await assetMaterializeTool.execute(
      { destination_path: "output.png" },
      dummyContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("attachment_id is required");
  });

  test("returns error when destination_path is missing", async () => {
    const result = await assetMaterializeTool.execute(
      { attachment_id: "some-id" },
      dummyContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("destination_path is required");
  });

  test("returns error when both params are missing", async () => {
    const result = await assetMaterializeTool.execute({}, dummyContext);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sandbox path enforcement
// ---------------------------------------------------------------------------

describe("AssetMaterializeTool sandbox path enforcement", () => {
  beforeEach(resetTables);

  test("rejects path that escapes sandbox via ../", async () => {
    const stored = uploadAttachment("test.png", "image/png", "AAAA");
    const result = await assetMaterializeTool.execute(
      { attachment_id: stored.id, destination_path: "../../etc/evil.png" },
      dummyContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside");
  });

  test("rejects absolute path outside sandbox", async () => {
    const stored = uploadAttachment("test.png", "image/png", "AAAA");
    const result = await assetMaterializeTool.execute(
      {
        attachment_id: stored.id,
        destination_path: "/tmp/outside-sandbox/evil.png",
      },
      dummyContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside");
  });

  test("accepts relative path inside sandbox", async () => {
    const stored = uploadAttachment("test.png", "image/png", "AAAA");
    const result = await assetMaterializeTool.execute(
      { attachment_id: stored.id, destination_path: "output.png" },
      dummyContext,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Materialized");
  });

  test("accepts nested path inside sandbox with auto-created subdirs", async () => {
    const stored = uploadAttachment("test.png", "image/png", "AAAA");
    const result = await assetMaterializeTool.execute(
      { attachment_id: stored.id, destination_path: "subdir/deep/output.png" },
      dummyContext,
    );
    expect(result.isError).toBe(false);
    expect(existsSync(join(sandboxDir, "subdir", "deep", "output.png"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Attachment lookup
// ---------------------------------------------------------------------------

describe("AssetMaterializeTool attachment lookup", () => {
  beforeEach(resetTables);

  test("returns error for non-existent attachment ID", async () => {
    const result = await assetMaterializeTool.execute(
      { attachment_id: "nonexistent-id", destination_path: "out.png" },
      dummyContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Successful materialization
// ---------------------------------------------------------------------------

describe("AssetMaterializeTool materialization", () => {
  beforeEach(resetTables);

  test("writes correct binary content to disk", async () => {
    // Create known content: "Hello, World!" in base64
    const originalContent = "Hello, World!";
    const base64Content = Buffer.from(originalContent).toString("base64");

    const stored = uploadAttachment("hello.txt", "text/plain", base64Content);

    const destPath = "materialized-hello.txt";
    const result = await assetMaterializeTool.execute(
      { attachment_id: stored.id, destination_path: destPath },
      dummyContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Materialized");
    expect(result.content).toContain("hello.txt");
    expect(result.content).toContain("text/plain");

    const writtenContent = readFileSync(join(sandboxDir, destPath), "utf-8");
    expect(writtenContent).toBe(originalContent);
  });

  test("writes binary (image) content correctly", async () => {
    // Small valid PNG-like bytes encoded as base64
    const binaryBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const base64Content = binaryBytes.toString("base64");

    const stored = uploadAttachment("tiny.png", "image/png", base64Content);

    const result = await assetMaterializeTool.execute(
      { attachment_id: stored.id, destination_path: "images/tiny.png" },
      dummyContext,
    );

    expect(result.isError).toBe(false);

    const writtenBytes = readFileSync(join(sandboxDir, "images", "tiny.png"));
    expect(Buffer.compare(writtenBytes, binaryBytes)).toBe(0);
  });

  test("result includes resolved path", async () => {
    const base64Content = Buffer.from("test").toString("base64");
    const stored = uploadAttachment("doc.txt", "text/plain", base64Content);

    const result = await assetMaterializeTool.execute(
      { attachment_id: stored.id, destination_path: "output/doc.txt" },
      dummyContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(join(sandboxDir, "output", "doc.txt"));
  });

  test("result includes filename, MIME type and size info", async () => {
    const base64Content = Buffer.from("some data here").toString("base64");
    const stored = uploadAttachment(
      "report.pdf",
      "application/pdf",
      base64Content,
    );

    const result = await assetMaterializeTool.execute(
      { attachment_id: stored.id, destination_path: "report.pdf" },
      dummyContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("report.pdf");
    expect(result.content).toContain("application/pdf");
  });
});

// ---------------------------------------------------------------------------
// Size limit enforcement
// ---------------------------------------------------------------------------

describe("AssetMaterializeTool size limit", () => {
  beforeEach(resetTables);

  test("rejects attachment exceeding 50MB limit", async () => {
    // Simulate a large attachment by inserting directly into the DB
    // with a sizeBytes value over the limit
    const db = getDb();
    const fakeId = "oversized-attachment";
    db.run(
      `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
       VALUES ('${fakeId}', 'huge.bin', 'application/octet-stream', ${
         51 * 1024 * 1024
       }, 'document', 'AAAA', ${Date.now()})`,
    );

    const result = await assetMaterializeTool.execute(
      { attachment_id: fakeId, destination_path: "huge.bin" },
      dummyContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds");
    expect(result.content).toContain("materialization limit");
  });
});

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("AssetMaterializeTool metadata", () => {
  test("tool definition has correct name", () => {
    const def = assetMaterializeTool.getDefinition();
    expect(def.name).toBe("asset_materialize");
  });

  test("tool definition has required params", () => {
    const def = assetMaterializeTool.getDefinition();
    expect((def.input_schema as Record<string, unknown>).required).toEqual([
      "attachment_id",
      "destination_path",
    ]);
  });

  test("tool definition has attachment_id and destination_path properties", () => {
    const def = assetMaterializeTool.getDefinition();
    expect(
      (def.input_schema as Record<string, unknown>).properties,
    ).toHaveProperty("attachment_id");
    expect(
      (def.input_schema as Record<string, unknown>).properties,
    ).toHaveProperty("destination_path");
  });

  test("tool has LOW risk level", () => {
    expect(assetMaterializeTool.defaultRiskLevel).toBe(RiskLevel.Low);
  });

  test("tool category is assets", () => {
    expect(assetMaterializeTool.category).toBe("assets");
  });

  test("tool name is asset_materialize", () => {
    expect(assetMaterializeTool.name).toBe("asset_materialize");
  });
});

// ---------------------------------------------------------------------------
// Visibility policy enforcement
// ---------------------------------------------------------------------------

describe("AssetMaterializeTool visibility policy", () => {
  beforeEach(resetTables);

  test("materializing from a standard thread works from any context", async () => {
    const standardConv = createConversation({ title: "standard-conv" });
    const base64Content = Buffer.from("standard content").toString("base64");
    const attachment = uploadAttachment(
      "public.txt",
      "text/plain",
      base64Content,
    );
    const msg = await addMessage(standardConv.id, "user", "standard message");
    linkAttachmentToMessage(msg.id, attachment.id, 0);

    // Materialize from a different standard conversation
    const otherConv = createConversation({ title: "other-conv" });
    const context: ToolContext = {
      workingDir: sandboxDir,
      conversationId: otherConv.id,
      trustClass: "guardian",
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: attachment.id, destination_path: "public-output.txt" },
      context,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Materialized");
  });

  test("materializing from a private thread works within the same private thread", async () => {
    const privateConv = createConversation({
      title: "private-conv",
      conversationType: "private",
    });
    const base64Content = Buffer.from("private content").toString("base64");
    const attachment = uploadAttachment(
      "secret.txt",
      "text/plain",
      base64Content,
    );
    const msg = await addMessage(privateConv.id, "user", "private message");
    linkAttachmentToMessage(msg.id, attachment.id, 0);

    // Materialize from the same private conversation
    const context: ToolContext = {
      workingDir: sandboxDir,
      conversationId: privateConv.id,
      trustClass: "guardian",
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: attachment.id, destination_path: "private-output.txt" },
      context,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Materialized");
  });

  test("materializing from a private thread is REJECTED from a different conversation", async () => {
    const privateConv = createConversation({
      title: "private-conv",
      conversationType: "private",
    });
    const base64Content = Buffer.from("private content").toString("base64");
    const attachment = uploadAttachment(
      "secret.txt",
      "text/plain",
      base64Content,
    );
    const msg = await addMessage(privateConv.id, "user", "private message");
    linkAttachmentToMessage(msg.id, attachment.id, 0);

    // Attempt to materialize from a different conversation
    const otherConv = createConversation({ title: "other-conv" });
    const context: ToolContext = {
      workingDir: sandboxDir,
      conversationId: otherConv.id,
      trustClass: "guardian",
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: attachment.id, destination_path: "stolen.txt" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("private conversation");
    expect(result.content).toContain("cannot be accessed");
  });

  test("error message is user-actionable", async () => {
    const privateConv = createConversation({
      title: "private-conv",
      conversationType: "private",
    });
    const base64Content = Buffer.from("private content").toString("base64");
    const attachment = uploadAttachment(
      "confidential.pdf",
      "application/pdf",
      base64Content,
    );
    const msg = await addMessage(privateConv.id, "user", "private message");
    linkAttachmentToMessage(msg.id, attachment.id, 0);

    // From a standard conversation
    const standardConv = createConversation({ title: "standard-conv" });
    const context: ToolContext = {
      workingDir: sandboxDir,
      conversationId: standardConv.id,
      trustClass: "guardian",
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: attachment.id, destination_path: "stolen.pdf" },
      context,
    );
    expect(result.isError).toBe(true);
    // Should mention the filename so the user knows which file
    expect(result.content).toContain("confidential.pdf");
    // Should explain how to access it
    expect(result.content).toContain("from within the private conversation");
  });

  test("materializing from a different private thread is REJECTED", async () => {
    const privateConv1 = createConversation({
      title: "private-conv-1",
      conversationType: "private",
    });
    const base64Content = Buffer.from("private content").toString("base64");
    const attachment = uploadAttachment(
      "secret.txt",
      "text/plain",
      base64Content,
    );
    const msg = await addMessage(privateConv1.id, "user", "private message");
    linkAttachmentToMessage(msg.id, attachment.id, 0);

    // Attempt from a different private conversation
    const privateConv2 = createConversation({
      title: "private-conv-2",
      conversationType: "private",
    });
    const context: ToolContext = {
      workingDir: sandboxDir,
      conversationId: privateConv2.id,
      trustClass: "guardian",
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: attachment.id, destination_path: "cross-thread.txt" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("private conversation");
  });

  test("attachment linked to both private and standard threads can be materialized from anywhere", async () => {
    const privateConv = createConversation({
      title: "private-conv",
      conversationType: "private",
    });
    const standardConv = createConversation({ title: "standard-conv" });
    const base64Content = Buffer.from("shared content").toString("base64");
    const attachment = uploadAttachment(
      "shared.txt",
      "text/plain",
      base64Content,
    );

    const msg1 = await addMessage(privateConv.id, "user", "private message");
    const msg2 = await addMessage(standardConv.id, "user", "standard message");
    linkAttachmentToMessage(msg1.id, attachment.id, 0);
    linkAttachmentToMessage(msg2.id, attachment.id, 0);

    // Should be materializable from a third, unrelated standard conversation
    const otherConv = createConversation({ title: "other-conv" });
    const context: ToolContext = {
      workingDir: sandboxDir,
      conversationId: otherConv.id,
      trustClass: "guardian",
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: attachment.id, destination_path: "shared-output.txt" },
      context,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Materialized");
  });
});

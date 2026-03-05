import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "runtime-attach-meta-test-")),
);

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
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
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  }),
}));

import {
  getAttachmentsByIds,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import * as conversationStore from "../memory/conversation-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

const TEST_TOKEN = "test-bearer-token-attach";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

describe("Runtime attachment metadata", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(async () => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM conversation_keys");

    // Use a random port to avoid conflicts
    port = 17000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
  });

  afterAll(async () => {
    await server?.stop();
  });

  test("GET /messages includes attachment metadata for assistant messages", async () => {
    const conversationKey = "test-conv-1";

    // Set up conversation and messages using "self" as the assistantId
    const mapping = getOrCreateConversation(conversationKey);
    await conversationStore.addMessage(mapping.conversationId, "user", "Hello");
    const assistantMsg = await conversationStore.addMessage(
      mapping.conversationId,
      "assistant",
      JSON.stringify([{ type: "text", text: "Here is a chart" }]),
    );

    // Upload and link an attachment using "self" as the assistantId
    const stored = uploadAttachment("chart.png", "image/png", "iVBOR");
    linkAttachmentToMessage(assistantMsg.id, stored.id, 0);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/messages?conversationKey=${conversationKey}`,
      { headers: AUTH_HEADERS },
    );
    const body = (await res.json()) as {
      messages: Array<{
        role: string;
        content: string;
        attachments: Array<{
          id: string;
          filename: string;
          mimeType: string;
          sizeBytes: number;
          kind: string;
        }>;
      }>;
    };

    expect(res.status).toBe(200);

    // Find the assistant message
    const aMsg = body.messages.find((m) => m.role === "assistant");
    expect(aMsg).toBeDefined();
    expect(aMsg!.attachments).toHaveLength(1);
    expect(aMsg!.attachments[0].id).toBe(stored.id);
    expect(aMsg!.attachments[0].filename).toBe("chart.png");
    expect(aMsg!.attachments[0].mimeType).toBe("image/png");
    expect(aMsg!.attachments[0].kind).toBe("image");
    expect(aMsg!.attachments[0].sizeBytes).toBeGreaterThan(0);

    // User message should have empty attachments
    const uMsg = body.messages.find((m) => m.role === "user");
    expect(uMsg).toBeDefined();
    expect(uMsg!.attachments).toEqual([]);
  });

  test("GET /messages returns empty attachments when none linked", async () => {
    const conversationKey = "test-conv-2";

    const mapping = getOrCreateConversation(conversationKey);
    await conversationStore.addMessage(mapping.conversationId, "user", "Hello");
    await conversationStore.addMessage(
      mapping.conversationId,
      "assistant",
      JSON.stringify([{ type: "text", text: "No attachments here" }]),
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/messages?conversationKey=${conversationKey}`,
      { headers: AUTH_HEADERS },
    );
    const body = (await res.json()) as {
      messages: Array<{ role: string; attachments: unknown[] }>;
    };

    expect(res.status).toBe(200);
    const aMsg = body.messages.find((m) => m.role === "assistant");
    expect(aMsg).toBeDefined();
    expect(aMsg!.attachments).toEqual([]);
  });

  test("GET /attachments/:id returns attachment with payload", async () => {
    const stored = uploadAttachment("report.pdf", "application/pdf", "JVBER");

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}`,
      { headers: AUTH_HEADERS },
    );
    const body = (await res.json()) as {
      id: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      kind: string;
      data: string;
    };

    expect(res.status).toBe(200);
    expect(body.id).toBe(stored.id);
    expect(body.filename).toBe("report.pdf");
    expect(body.mimeType).toBe("application/pdf");
    expect(body.kind).toBe("document");
    expect(body.data).toBe("JVBER");
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  test('GET /attachments/:id returns attachment stored under "self"', async () => {
    const stored = uploadAttachment("shared.txt", "text/plain", "c2hhcmVk");

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}`,
      { headers: AUTH_HEADERS },
    );
    const body = (await res.json()) as { id: string; filename: string };

    expect(res.status).toBe(200);
    expect(body.id).toBe(stored.id);
    expect(body.filename).toBe("shared.txt");
  });

  test("GET /attachments/:id returns 404 for nonexistent attachment", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/nonexistent-id`,
      { headers: AUTH_HEADERS },
    );
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };

    expect(res.status).toBe(404);
    expect(body.error.message).toBe("Attachment not found");
  });
});

describe("WhatsApp channel ingress attachment resolution", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(async () => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM conversation_keys");

    port = 18000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
  });

  test("uploaded attachment IDs from channel ingress resolve via GET /attachments/:id", async () => {
    // Simulate what the gateway does: upload an attachment (downloaded from
    // WhatsApp) to the runtime attachment store before forwarding the inbound
    // event. The runtime must be able to resolve these IDs.
    const img = uploadAttachment(
      "whatsapp-photo.jpg",
      "image/jpeg",
      "/9j/4AAQ",
    );
    const doc = uploadAttachment("receipt.pdf", "application/pdf", "JVBERi0x");

    // Both attachments should be individually retrievable
    const imgRes = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${img.id}`,
      { headers: AUTH_HEADERS },
    );
    expect(imgRes.status).toBe(200);
    const imgBody = (await imgRes.json()) as {
      id: string;
      filename: string;
      mimeType: string;
      kind: string;
      data: string;
    };
    expect(imgBody.id).toBe(img.id);
    expect(imgBody.filename).toBe("whatsapp-photo.jpg");
    expect(imgBody.mimeType).toBe("image/jpeg");
    expect(imgBody.kind).toBe("image");
    expect(imgBody.data).toBe("/9j/4AAQ");

    const docRes = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${doc.id}`,
      { headers: AUTH_HEADERS },
    );
    expect(docRes.status).toBe(200);
    const docBody = (await docRes.json()) as {
      id: string;
      filename: string;
      mimeType: string;
      kind: string;
    };
    expect(docBody.id).toBe(doc.id);
    expect(docBody.filename).toBe("receipt.pdf");
    expect(docBody.mimeType).toBe("application/pdf");
    expect(docBody.kind).toBe("document");
  });

  test("batch-uploaded WhatsApp attachment IDs resolve via getAttachmentsByIds", async () => {
    // The inbound message handler calls getAttachmentsByIds to validate that
    // all IDs exist before processing. This test proves that pattern works
    // for WhatsApp-originated uploads.
    const a1 = uploadAttachment("photo1.jpg", "image/jpeg", "base64img1");
    const a2 = uploadAttachment("photo2.png", "image/png", "base64img2");
    const a3 = uploadAttachment("voice.ogg", "audio/ogg", "base64audio");

    const resolved = getAttachmentsByIds([a1.id, a2.id, a3.id]);
    expect(resolved).toHaveLength(3);

    const resolvedIds = resolved.map((a) => a.id);
    expect(resolvedIds).toContain(a1.id);
    expect(resolvedIds).toContain(a2.id);
    expect(resolvedIds).toContain(a3.id);

    // Each resolved attachment carries the correct metadata
    const photo1 = resolved.find((a) => a.id === a1.id)!;
    expect(photo1.originalFilename).toBe("photo1.jpg");
    expect(photo1.mimeType).toBe("image/jpeg");

    const audio = resolved.find((a) => a.id === a3.id)!;
    expect(audio.originalFilename).toBe("voice.ogg");
    expect(audio.mimeType).toBe("audio/ogg");
  });

  test("partially missing attachment IDs are detected (mixed valid/invalid)", async () => {
    // When one attachment upload fails at the gateway, the remaining IDs
    // still need to resolve. The inbound handler detects missing IDs by
    // comparing resolved count to requested count.
    const valid = uploadAttachment("ok.jpg", "image/jpeg", "base64ok");
    const ids = [valid.id, "nonexistent-whatsapp-att"];

    const resolved = getAttachmentsByIds(ids);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe(valid.id);
  });
});

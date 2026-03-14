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

mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

import { upsertContact } from "../contacts/contact-store.js";
import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import * as conversationStore from "../memory/conversation-crud.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { getDb, initializeDb, resetDb, resetTestTables } from "../memory/db.js";
import * as deliveryChannels from "../memory/delivery-channels.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

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
  const WHATSAPP_USER_ID = "whatsapp-user-123";
  let ingressServer: RuntimeHttpServer;
  let ingressPort: number;

  function resetIngressTables(): void {
    resetTestTables(
      "message_attachments",
      "attachments",
      "channel_inbound_events",
      "message_runs",
      "messages",
      "conversations",
      "conversation_keys",
      "contact_channels",
      "contacts",
    );
    deliveryChannels.resetAllRunDeliveryClaims();
    pendingInteractions.clear();
  }

  function ensureWhatsAppContact(): void {
    upsertContact({
      displayName: "WhatsApp Test User",
      channels: [
        {
          type: "whatsapp",
          address: WHATSAPP_USER_ID,
          externalUserId: WHATSAPP_USER_ID,
          status: "active",
          policy: "allow",
        },
      ],
    });
  }

  function makeInboundBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      sourceChannel: "whatsapp",
      interface: "whatsapp",
      conversationExternalId: "whatsapp-chat-1",
      actorExternalId: WHATSAPP_USER_ID,
      externalMessageId: `wa-msg-${Date.now()}-${Math.random()}`,
      content: "Check these attachments",
      replyCallbackUrl: "https://gateway.test/deliver",
      ...overrides,
    };
  }

  // Create a real message in the DB so the background dispatch's
  // linkMessage(eventId, userMessageId) FK constraint is satisfied.
  const noopProcessMessage = mock(
    async (conversationId: string, content: string) => {
      const msg = await conversationStore.addMessage(
        conversationId,
        "user",
        content,
      );
      return { messageId: msg.id };
    },
  );

  beforeEach(async () => {
    resetIngressTables();
    ensureWhatsAppContact();
    noopProcessMessage.mockClear();

    ingressPort = 18000 + Math.floor(Math.random() * 1000);
    ingressServer = new RuntimeHttpServer({
      port: ingressPort,
      bearerToken: TEST_TOKEN,
      processMessage: noopProcessMessage,
    });
    await ingressServer.start();
  });

  afterEach(async () => {
    await ingressServer?.stop();
  });

  test("inbound handler accepts request with valid gateway-uploaded attachment IDs", async () => {
    // Simulate what the gateway does: upload attachments then forward the
    // inbound event with attachmentIds. The handler must resolve them.
    const img = uploadAttachment(
      "whatsapp-photo.jpg",
      "image/jpeg",
      "/9j/4AAQ",
    );
    const doc = uploadAttachment("receipt.pdf", "application/pdf", "JVBERi0x");

    const res = await fetch(
      `http://127.0.0.1:${ingressPort}/v1/channels/inbound`,
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(
          makeInboundBody({ attachmentIds: [img.id, doc.id] }),
        ),
      },
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
  });

  test("inbound handler rejects request when some attachment IDs are missing", async () => {
    // When the gateway fails to upload one attachment, the handler detects
    // the missing ID and returns a 400.
    const valid = uploadAttachment("ok.jpg", "image/jpeg", "base64ok");

    const res = await fetch(
      `http://127.0.0.1:${ingressPort}/v1/channels/inbound`,
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(
          makeInboundBody({
            attachmentIds: [valid.id, "nonexistent-whatsapp-att"],
          }),
        ),
      },
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("nonexistent-whatsapp-att");
  });

  test("inbound handler accepts attachment-only message with no text content", async () => {
    // WhatsApp allows sending images/documents without caption text.
    const img = uploadAttachment("photo.jpg", "image/jpeg", "/9j/4AAQ");

    const res = await fetch(
      `http://127.0.0.1:${ingressPort}/v1/channels/inbound`,
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(
          makeInboundBody({ content: "", attachmentIds: [img.id] }),
        ),
      },
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

// The inbound handler imports processMessage directly — stub it so it doesn't
// attempt to spin up an LLM turn. The background dispatch is fire-and-forget;
// tests only assert on the synchronous HTTP response.
mock.module("../daemon/process-message.js", () => ({
  resolveTurnChannel: () => "whatsapp",
  resolveTurnInterface: () => "whatsapp",
  prepareConversationForMessage: async () => ({}),
  processMessage: async () => ({ messageId: `mock-msg-${Date.now()}` }),
  processMessageInBackground: async () => ({ messageId: "mock-bg" }),
}));

mock.module("../daemon/approval-generators.js", () => ({
  createApprovalCopyGenerator: () => undefined,
  createApprovalConversationGenerator: () => undefined,
}));

import {
  getFilePathForAttachment,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import * as conversationStore from "../persistence/conversation-crud.js";
import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import * as deliveryChannels from "../persistence/delivery-channels.js";
import { rawRun, resetTestTables } from "../persistence/raw-query.js";
import { ACTOR_PRINCIPALS } from "../runtime/auth/route-policy.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { ROUTES as ATTACHMENT_ROUTES } from "../runtime/routes/attachment-routes.js";
import {
  RangeNotSatisfiableError,
  UnsupportedMediaTypeError,
} from "../runtime/routes/errors.js";
import { RouteResponse } from "../runtime/routes/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import {
  fakeHeifHeaderBytes,
  makeHeicFixtureBytes,
  PNG_1PX_BYTES,
} from "./heic-fixture.js";
import {
  resolveLocalTrustVerdict,
  seedContactChannel,
} from "./helpers/channel-test-adapter.js";
import { setConfig } from "./helpers/set-config.js";

// Tests call addMessage without skipIndexing — keep memory indexing off so no
// background memory work runs against the test DB.
setConfig("memory", { enabled: false, v2: { enabled: false } });

await initializeDb();

afterAll(() => {
  resetDbForTesting();
});

const TEST_TOKEN = "test-bearer-token-attach";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };
const ATTACHMENT_CONTENT_ROUTE = ATTACHMENT_ROUTES.find(
  (candidate) => candidate.operationId === "attachment_content",
)!;

function expectOnlyProjectedAttachmentPreflightSelects(
  calls: readonly (readonly unknown[])[],
): void {
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call[0]).toBeDefined();
  }
}

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
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
  });

  afterAll(async () => {
    await server?.stop();
  });

  test("attachment content representations retain attachment read authorization", () => {
    expect(ATTACHMENT_CONTENT_ROUTE.policy).toEqual({
      requiredScopes: ["attachments.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    });
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
    const stored = uploadAttachment("chart.png", "image/png", "iVBORw==");
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
    const stored = uploadAttachment(
      "report.pdf",
      "application/pdf",
      "JVBERA==",
    );

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
    expect(body.data).toBe("JVBERA==");
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

  test("display representation returns browser image bytes with bounded headers", async () => {
    const stored = uploadAttachment(
      "pixel.png",
      "image/png",
      PNG_1PX_BYTES.toString("base64"),
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}/content?representation=display`,
      { headers: AUTH_HEADERS },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(
      String(PNG_1PX_BYTES.length),
    );
    expect(res.headers.get("accept-ranges")).toBe("none");
    expect(res.headers.get("cache-control")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_1PX_BYTES);
  });

  test("file-backed native display streams after a bounded format sniff", async () => {
    const mapping = getOrCreateConversation("display-stream");
    const message = await conversationStore.addMessage(
      mapping.conversationId,
      "user",
      "image",
    );
    const stored = uploadAttachment(
      "pixel.png",
      "image/png",
      PNG_1PX_BYTES.toString("base64"),
    );
    const attachmentId = linkAttachmentToMessage(message.id, stored.id, 0);
    const attachmentPath = getFilePathForAttachment(attachmentId)!;
    const expandedSize = 32 * 1024 * 1024;
    truncateSync(attachmentPath, expandedSize);
    rawRun(
      "test:mislabeledNativeDisplayImage",
      "UPDATE attachments SET mime_type = ?, size_bytes = ? WHERE id = ?",
      "image/heic",
      expandedSize,
      attachmentId,
    );

    const result = await ATTACHMENT_CONTENT_ROUTE.handler({
      pathParams: { id: attachmentId },
      queryParams: { representation: "display" },
    });

    expect(result).toBeInstanceOf(RouteResponse);
    const response = result as RouteResponse;
    expect(response.body).toBeInstanceOf(Blob);
    expect(response.body).not.toBeInstanceOf(Uint8Array);
    expect(response.headers).toEqual({
      "Content-Type": "image/png",
      "Content-Length": String(expandedSize),
      "Accept-Ranges": "none",
    });
  });

  test("explicit original representation preserves file-backed Range behavior", async () => {
    const bytes = PNG_1PX_BYTES;
    const mapping = getOrCreateConversation("original-range");
    const message = await conversationStore.addMessage(
      mapping.conversationId,
      "user",
      "image",
    );
    const stored = uploadAttachment(
      "pixel.png",
      "image/png",
      bytes.toString("base64"),
    );
    const attachmentId = linkAttachmentToMessage(message.id, stored.id, 0);

    const defaultRes = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${attachmentId}/content`,
      { headers: { ...AUTH_HEADERS, Range: "bytes=0-3" } },
    );
    const explicitRes = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${attachmentId}/content?representation=original`,
      { headers: { ...AUTH_HEADERS, Range: "bytes=0-3" } },
    );

    expect(defaultRes.status).toBe(206);
    expect(explicitRes.status).toBe(defaultRes.status);
    expect(defaultRes.headers.get("content-range")).toBe(
      `bytes 0-3/${bytes.length}`,
    );
    expect(explicitRes.headers.get("content-range")).toBe(
      `bytes 0-3/${bytes.length}`,
    );
    expect(Buffer.from(await explicitRes.arrayBuffer())).toEqual(
      Buffer.from(await defaultRes.arrayBuffer()),
    );
  });

  test("display representation rejects Range after resolving the attachment", async () => {
    const stored = uploadAttachment(
      "pixel.png",
      "image/png",
      PNG_1PX_BYTES.toString("base64"),
    );

    const rangeRes = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}/content?representation=display`,
      { headers: { ...AUTH_HEADERS, Range: "bytes=0-3" } },
    );
    const missingRes = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/missing/content?representation=display`,
      { headers: { ...AUTH_HEADERS, Range: "bytes=0-3" } },
    );

    expect(rangeRes.status).toBe(416);
    expect(missingRes.status).toBe(404);
  });

  test("inline display Range rejection does not select the content row", () => {
    const stored = uploadAttachment(
      "pixel.png",
      "image/png",
      PNG_1PX_BYTES.toString("base64"),
    );
    const selectSpy = spyOn(getDb(), "select");
    try {
      expect(() =>
        ATTACHMENT_CONTENT_ROUTE.handler({
          pathParams: { id: stored.id },
          queryParams: { representation: "display" },
          headers: { range: "bytes=0-3" },
        }),
      ).toThrow(RangeNotSatisfiableError);

      expectOnlyProjectedAttachmentPreflightSelects(selectSpy.mock.calls);
    } finally {
      selectSpy.mockRestore();
    }
  });

  test("inline non-image display rejects without selecting the content row", () => {
    const stored = uploadAttachment(
      "report.pdf",
      "application/pdf",
      "JVBERA==",
    );
    const selectSpy = spyOn(getDb(), "select");
    try {
      expect(() =>
        ATTACHMENT_CONTENT_ROUTE.handler({
          pathParams: { id: stored.id },
          queryParams: { representation: "display" },
        }),
      ).toThrow(UnsupportedMediaTypeError);

      expectOnlyProjectedAttachmentPreflightSelects(selectSpy.mock.calls);
    } finally {
      selectSpy.mockRestore();
    }
  });

  test("display representation rejects non-image files before reading their path", async () => {
    const mapping = getOrCreateConversation("display-non-image");
    const message = await conversationStore.addMessage(
      mapping.conversationId,
      "user",
      "document",
    );
    const stored = uploadAttachment(
      "report.pdf",
      "application/pdf",
      "JVBERA==",
    );
    const attachmentId = linkAttachmentToMessage(message.id, stored.id, 0);
    const attachmentPath = getFilePathForAttachment(attachmentId)!;
    const unreadablePath = join(dirname(attachmentPath), "not-a-file");
    mkdirSync(unreadablePath);
    rawRun(
      "test:pointAttachmentAtDirectory",
      "UPDATE attachments SET file_path = ? WHERE id = ?",
      unreadablePath,
      attachmentId,
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${attachmentId}/content?representation=display`,
      { headers: AUTH_HEADERS },
    );

    expect(res.status).toBe(415);
  });

  test("display representation rejects HEIF when conversion is unavailable", async () => {
    const stored = uploadAttachment(
      "broken.heic",
      "image/heic",
      fakeHeifHeaderBytes().toString("base64"),
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}/content?representation=display`,
      { headers: AUTH_HEADERS },
    );

    expect(res.status).toBe(415);
  });

  test("display representation rejects corrupt HEIC candidates", async () => {
    const stored = uploadAttachment(
      "corrupt.heic",
      "image/heic",
      Buffer.from("not-heif").toString("base64"),
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}/content?representation=display`,
      { headers: AUTH_HEADERS },
    );

    expect(res.status).toBe(415);
  });

  test.skipIf(process.platform !== "darwin")(
    "display representation converts legacy HEIF bytes to JPEG",
    async () => {
      const heic = makeHeicFixtureBytes();
      if (!heic) {
        return;
      }
      const id = randomUUID();
      rawRun(
        "test:insertLegacyHeicAttachment",
        `INSERT INTO attachments
          (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        "legacy.heic",
        "image/heic",
        heic.length,
        "image",
        heic.toString("base64"),
        Date.now(),
      );

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/attachments/${id}/content?representation=display`,
        { headers: AUTH_HEADERS },
      );
      const bytes = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("content-length")).toBe(String(bytes.length));
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    },
    30_000,
  );
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
    seedContactChannel({
      sourceChannel: "whatsapp",
      externalUserId: WHATSAPP_USER_ID,
      displayName: "WhatsApp Test User",
      status: "active",
      policy: "allow",
    });
  }

  function makeInboundBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    // Mirror the gateway: stamp a trust verdict from the local contact store so
    // the daemon's fail-closed ACL stage admits the request to attachment logic.
    const trustVerdict = resolveLocalTrustVerdict({
      channelType: "whatsapp",
      actorExternalId: WHATSAPP_USER_ID,
    });
    return {
      sourceChannel: "whatsapp",
      interface: "whatsapp",
      conversationExternalId: "whatsapp-chat-1",
      actorExternalId: WHATSAPP_USER_ID,
      externalMessageId: `wa-msg-${Date.now()}-${Math.random()}`,
      content: "Check these attachments",
      replyCallbackUrl: "https://gateway.test/deliver",
      sourceMetadata: { trustVerdict },
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
    const body = (await res.json()) as {
      error?: { code?: string; message?: string } | string;
    };

    expect(res.status).toBe(400);
    const errorMsg =
      typeof body.error === "string" ? body.error : (body.error?.message ?? "");
    expect(errorMsg).toContain("nonexistent-whatsapp-att");
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

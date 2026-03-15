import { describe, test, expect, mock, afterEach } from "bun:test";
import type {
  RuntimeAttachmentMeta,
  RuntimeInboundPayload,
} from "../runtime/client.js";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const {
  forwardToRuntime,
  downloadAttachment,
  forwardTwilioVoiceWebhook,
  forwardTwilioStatusWebhook,
  forwardTwilioConnectActionWebhook,
} = await import("../runtime/client.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

const payload: RuntimeInboundPayload = {
  sourceChannel: "telegram",
  interface: "telegram",
  conversationExternalId: "99001",
  externalMessageId: "123",
  content: "Hello",
  actorDisplayName: "Test User",
  actorExternalId: "55001",
};

const testAttachment: RuntimeAttachmentMeta = {
  id: "att-1",
  filename: "chart.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  kind: "generated_image",
};

const successBody = {
  accepted: true,
  duplicate: false,
  eventId: "evt-1",
  assistantMessage: {
    id: "msg-1",
    role: "assistant" as const,
    content: "Hi there!",
    timestamp: new Date().toISOString(),
    attachments: [testAttachment],
  },
};

describe("forwardToRuntime", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("successful forward returns runtime response", async () => {
    fetchMock = mock(
      async () => new Response(JSON.stringify(successBody), { status: 200 }),
    );

    const config = makeConfig();
    const result = await forwardToRuntime(config, payload);
    expect(result.accepted).toBe(true);
    expect(result.eventId).toBe("evt-1");
    expect(result.assistantMessage?.content).toBe("Hi there!");
  });

  test("4xx error throws immediately without retry", async () => {
    fetchMock = mock(async () => new Response("Bad request", { status: 400 }));

    const config = makeConfig();
    await expect(forwardToRuntime(config, payload)).rejects.toThrow(
      "Runtime returned 400",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("5xx error retries and eventually succeeds", async () => {
    const config = makeConfig();
    const expectedUrl = `${config.assistantRuntimeBaseUrl}/v1/channels/inbound`;
    let inboundCallCount = 0;
    fetchMock = mock(async (input) => {
      const calledUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (calledUrl === expectedUrl) {
        inboundCallCount++;
      }

      if (inboundCallCount <= 2) {
        return new Response("Internal error", { status: 500 });
      }
      return new Response(JSON.stringify(successBody), { status: 200 });
    });

    const result = await forwardToRuntime(config, payload);
    expect(result.accepted).toBe(true);
    const callsToInboundRoute = fetchMock.mock.calls.filter((call) => {
      const calledUrl = call[0];
      return typeof calledUrl === "string" && calledUrl === expectedUrl;
    });
    expect(callsToInboundRoute).toHaveLength(3);
  });

  test("5xx error exhausts retries and throws", async () => {
    fetchMock = mock(async () => new Response("Server error", { status: 500 }));

    const config = makeConfig();
    await expect(forwardToRuntime(config, payload)).rejects.toThrow(
      "Runtime returned 500",
    );
  });

  test("response includes typed attachment metadata", async () => {
    fetchMock = mock(
      async () => new Response(JSON.stringify(successBody), { status: 200 }),
    );

    const config = makeConfig();
    const result = await forwardToRuntime(config, payload);
    const attachments = result.assistantMessage?.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe("att-1");
    expect(attachments[0].filename).toBe("chart.png");
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].sizeBytes).toBe(1024);
    expect(attachments[0].kind).toBe("generated_image");
  });

  test("sends JWT Authorization header to runtime", async () => {
    fetchMock = mock(
      async () => new Response(JSON.stringify(successBody), { status: 200 }),
    );

    const config = makeConfig({});
    await forwardToRuntime(config, payload);

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Bearer ey/);
  });
});

describe("downloadAttachment", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("downloads attachment payload with base64 data", async () => {
    const attachmentPayload = {
      id: "att-1",
      filename: "chart.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      kind: "generated_image",
      data: "iVBORw0KGgo=",
    };

    fetchMock = mock(
      async () =>
        new Response(JSON.stringify(attachmentPayload), { status: 200 }),
    );

    const config = makeConfig();
    const result = await downloadAttachment(config, "att-1");
    expect(result.id).toBe("att-1");
    expect(result.filename).toBe("chart.png");
    expect(result.data).toBe("iVBORw0KGgo=");

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toContain("/attachments/att-1");
  });

  test("transparently hydrates file-backed attachments from /content endpoint", async () => {
    const binaryContent = Buffer.from("fake-binary-content");
    const attachmentMeta = {
      id: "att-fb-1",
      filename: "video.mov",
      mimeType: "video/quicktime",
      sizeBytes: binaryContent.length,
      fileBacked: true,
      // data is absent — file-backed attachment
    };

    let callCount = 0;
    fetchMock = mock(async (input) => {
      const calledUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      callCount++;
      if (calledUrl.endsWith("/content")) {
        // Return raw binary for the /content endpoint
        return new Response(new Uint8Array(binaryContent), { status: 200 });
      }
      // Return the JSON metadata (no data field)
      return new Response(JSON.stringify(attachmentMeta), { status: 200 });
    });

    const config = makeConfig();
    const result = await downloadAttachment(config, "att-fb-1");

    expect(result.id).toBe("att-fb-1");
    expect(result.fileBacked).toBe(true);
    // data should be hydrated with base64-encoded binary content
    expect(result.data).toBe(binaryContent.toString("base64"));
    // Should have made two calls: one for metadata, one for /content
    expect(callCount).toBe(2);
  });

  test("throws on 404 not found", async () => {
    fetchMock = mock(
      async () =>
        new Response('{"error":"Attachment not found"}', { status: 404 }),
    );

    const config = makeConfig();
    await expect(downloadAttachment(config, "nonexistent")).rejects.toThrow(
      "Attachment download failed (404)",
    );
  });
});

describe("forwardTwilioVoiceWebhook", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("sends params and originalUrl to runtime internal endpoint", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(
      async () =>
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const config = makeConfig({});
    const params = { CallSid: "CA123", AccountSid: "AC456" };
    const originalUrl =
      "https://example.com/webhooks/twilio/voice?callSessionId=sess-1";

    const result = await forwardTwilioVoiceWebhook(config, params, originalUrl);
    expect(result.status).toBe(200);
    expect(result.body).toBe(twiml);
    expect(result.headers["Content-Type"]).toBe("text/xml");

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe(
      "http://localhost:7821/v1/internal/twilio/voice-webhook",
    );

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.params).toEqual(params);
    expect(sentBody.originalUrl).toBe(originalUrl);

    const headers = calledInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Bearer ey/);
  });
});

describe("forwardTwilioStatusWebhook", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("sends params to runtime internal status endpoint", async () => {
    fetchMock = mock(async () => new Response(null, { status: 200 }));

    const config = makeConfig({});
    const params = { CallSid: "CA123", CallStatus: "completed" };

    const result = await forwardTwilioStatusWebhook(config, params);
    expect(result.status).toBe(200);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("http://localhost:7821/v1/internal/twilio/status");

    const calledInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.params).toEqual(params);
  });
});

describe("forwardTwilioConnectActionWebhook", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("sends params to runtime internal connect-action endpoint", async () => {
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    fetchMock = mock(
      async () =>
        new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );

    const config = makeConfig({});
    const params = { CallSid: "CA123" };

    const result = await forwardTwilioConnectActionWebhook(config, params);
    expect(result.status).toBe(200);
    expect(result.body).toBe(twiml);

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe(
      "http://localhost:7821/v1/internal/twilio/connect-action",
    );
  });

  test("returns runtime error status and body", async () => {
    fetchMock = mock(
      async () => new Response('{"error":"Not found"}', { status: 404 }),
    );

    const config = makeConfig();
    const result = await forwardTwilioConnectActionWebhook(config, {
      CallSid: "CA999",
    });
    expect(result.status).toBe(404);
    expect(result.body).toContain("Not found");
  });
});

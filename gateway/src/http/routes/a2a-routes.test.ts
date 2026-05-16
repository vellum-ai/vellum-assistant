import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";

// --- Mocks ----------------------------------------------------------------

const handleInboundMock = mock(
  (_config: GatewayConfig, _normalized: unknown, _options?: unknown) =>
    Promise.resolve({ forwarded: true, rejected: false }),
);

const assistantDbRunMock = mock((_sql: string, _bind?: unknown[]) =>
  Promise.resolve({ changes: 1, lastInsertRowid: 0 }),
);

const assistantDbQueryMock = mock((_sql: string, _bind?: unknown[]) =>
  Promise.resolve([]),
);

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));

mock.module("../../db/assistant-db-proxy.js", () => ({
  assistantDbRun: assistantDbRunMock,
  assistantDbQuery: assistantDbQueryMock,
}));

mock.module("../../runtime/client.js", () => ({
  CircuitBreakerOpenError: class extends Error {},
}));

// Import after mocks are registered
const {
  createAgentCardHandler,
  createSendMessageHandler,
  createPushWebhookHandler,
} = await import("./a2a-routes.js");

// --- Helpers ---------------------------------------------------------------

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://localhost:7821",
  defaultAssistantId: "ast-default",
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: {
    telegram: 50 * 1024 * 1024,
    slack: 100 * 1024 * 1024,
    whatsapp: 16 * 1024 * 1024,
    default: 50 * 1024 * 1024,
  },
  maxAttachmentConcurrency: 3,
  maxWebhookPayloadBytes: 1024 * 1024,
  port: 7830,
  routingEntries: [],
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  unmappedPolicy: "default",
  trustProxy: false,
};

function makeConfigFileCache(overrides?: {
  a2aEnabled?: boolean;
  publicBaseUrl?: string;
}) {
  const data: Record<string, Record<string, unknown>> = {
    a2a: { enabled: overrides?.a2aEnabled ?? false },
    ingress: {
      publicBaseUrl: overrides?.publicBaseUrl ?? "https://example.com",
    },
  };

  return {
    getBoolean: (section: string, field: string) => {
      const val = data[section]?.[field];
      return typeof val === "boolean" ? val : undefined;
    },
    getString: (section: string, field: string) => {
      const val = data[section]?.[field];
      return typeof val === "string" ? val : undefined;
    },
  } as import("../../config-file-cache.js").ConfigFileCache;
}

function makeSendMessageRequest(
  overrides?: Partial<{
    message: Record<string, unknown>;
    configuration: Record<string, unknown>;
    senderAssistantId: string;
    senderName: string;
  }>,
): Request {
  const body = {
    message: overrides?.message ?? {
      message_id: "msg-1",
      role: "user",
      parts: [{ kind: "text", text: "Hello from peer" }],
    },
    ...(overrides?.configuration
      ? { configuration: overrides.configuration }
      : {}),
  };

  return new Request("http://localhost:7830/a2a/message:send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(overrides?.senderAssistantId
        ? { "x-sender-assistant-id": overrides.senderAssistantId }
        : {}),
      ...(overrides?.senderName
        ? { "x-sender-name": overrides.senderName }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

// --- Tests -----------------------------------------------------------------

describe("Agent Card", () => {
  it("returns 404 when A2A is not enabled", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: false });
    const handler = createAgentCardHandler(configFile);

    const res = await handler(
      new Request("http://localhost:7830/.well-known/agent-card.json"),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not enabled");
  });

  it("serves agent card when enabled", async () => {
    const configFile = makeConfigFileCache({
      a2aEnabled: true,
      publicBaseUrl: "https://my-assistant.example.com",
    });
    const handler = createAgentCardHandler(configFile);

    const res = await handler(
      new Request("http://localhost:7830/.well-known/agent-card.json"),
    );

    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      name: string;
      supported_interfaces: Array<{ url: string }>;
      capabilities: { push_notifications: boolean };
    };
    expect(card.name).toBe("Vellum Assistant");
    expect(card.supported_interfaces[0].url).toBe(
      "https://my-assistant.example.com/a2a",
    );
    expect(card.capabilities.push_notifications).toBe(true);
  });

  it("returns 503 when no public base URL is configured", async () => {
    const configFile = makeConfigFileCache({
      a2aEnabled: true,
      publicBaseUrl: "",
    });
    const handler = createAgentCardHandler(configFile);

    const res = await handler(
      new Request("http://localhost:7830/.well-known/agent-card.json"),
    );

    expect(res.status).toBe(503);
  });
});

describe("message:send", () => {
  beforeEach(() => {
    handleInboundMock.mockClear();
    assistantDbRunMock.mockClear();
    assistantDbQueryMock.mockClear();
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
  });

  it("returns 404 when A2A is not enabled", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: false });
    const handler = createSendMessageHandler(baseConfig, configFile);

    const res = await handler(makeSendMessageRequest());

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid message payload", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: true });
    const handler = createSendMessageHandler(baseConfig, configFile);

    const res = await handler(
      new Request("http://localhost:7830/a2a/message:send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: { bad: true } }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("creates task and forwards message through inbound pipeline", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: true });
    const handler = createSendMessageHandler(baseConfig, configFile);

    const res = await handler(
      makeSendMessageRequest({ senderAssistantId: "peer-ast-1" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { id: string; status: { state: string } };
    };
    expect(body.task.id).toBeTruthy();
    expect(body.task.status.state).toBe("submitted");

    // Verify task was created in DB
    expect(assistantDbRunMock).toHaveBeenCalledTimes(1);
    const dbCall = assistantDbRunMock.mock.calls[0];
    expect(dbCall[0]).toContain("INSERT INTO a2a_tasks");

    // Verify handleInbound was called with normalized event
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [_config, event] = handleInboundMock.mock.calls[0];
    expect((event as { sourceChannel: string }).sourceChannel).toBe("a2a");
    expect(
      (event as { actor: { actorExternalId: string } }).actor.actorExternalId,
    ).toBe("peer-ast-1");
  });

  it("returns rejected task when routing rejects the message", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: false,
        rejected: true,
        rejectionReason: "Untrusted sender",
      }),
    );

    const configFile = makeConfigFileCache({ a2aEnabled: true });
    const handler = createSendMessageHandler(baseConfig, configFile);

    const res = await handler(makeSendMessageRequest());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { status: { state: string } };
    };
    expect(body.task.status.state).toBe("rejected");
  });

  it("extracts push notification URL from configuration", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: true });
    const handler = createSendMessageHandler(baseConfig, configFile);

    const res = await handler(
      makeSendMessageRequest({
        configuration: {
          task_push_notification_config: {
            url: "https://peer.example.com/a2a/push",
          },
        },
      }),
    );

    expect(res.status).toBe(200);

    // Verify push URL was stored in DB
    const dbCall = assistantDbRunMock.mock.calls[0];
    const bindParams = dbCall[1] as (string | null)[];
    // push_url is the 4th bind parameter
    expect(bindParams[3]).toBe("https://peer.example.com/a2a/push");
  });
});

describe("push webhook", () => {
  beforeEach(() => {
    handleInboundMock.mockClear();
    assistantDbQueryMock.mockClear();
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: true, rejected: false }),
    );
  });

  it("returns 404 when A2A is not enabled", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: false });
    const handler = createPushWebhookHandler(baseConfig, configFile);

    const res = await handler(
      new Request("http://localhost:7830/a2a/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: {
            id: "task-1",
            status: { state: "completed", timestamp: new Date().toISOString() },
          },
        }),
      }),
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid push payload", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: true });
    const handler = createPushWebhookHandler(baseConfig, configFile);

    const res = await handler(
      new Request("http://localhost:7830/a2a/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("accepts push and forwards through inbound pipeline", async () => {
    assistantDbQueryMock.mockImplementation(() =>
      Promise.resolve([
        {
          id: "task-1",
          context_id: "ctx-1",
          state: "working",
          status_message: null,
          artifacts_json: null,
          updated_at: Date.now(),
          sender_assistant_id: "peer-ast-1",
        },
      ]),
    );

    const configFile = makeConfigFileCache({ a2aEnabled: true });
    const handler = createPushWebhookHandler(baseConfig, configFile);

    const res = await handler(
      new Request("http://localhost:7830/a2a/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: {
            id: "task-1",
            status: {
              state: "completed",
              message: {
                message_id: "resp-1",
                role: "agent",
                parts: [{ kind: "text", text: "Here is my response" }],
              },
              timestamp: new Date().toISOString(),
            },
          },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    const [_config, event] = handleInboundMock.mock.calls[0];
    expect((event as { sourceChannel: string }).sourceChannel).toBe("a2a");
    // context_id from stored task is used for conversation routing
    expect(
      (event as { message: { conversationExternalId: string } }).message
        .conversationExternalId,
    ).toBe("ctx-1");
  });

  it("handles push for unknown task gracefully", async () => {
    assistantDbQueryMock.mockImplementation(() => Promise.resolve([]));

    const configFile = makeConfigFileCache({ a2aEnabled: true });
    const handler = createPushWebhookHandler(baseConfig, configFile);

    const res = await handler(
      new Request("http://localhost:7830/a2a/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: {
            id: "unknown-task",
            context_id: "ctx-fallback",
            status: {
              state: "completed",
              timestamp: new Date().toISOString(),
            },
          },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
  });
});

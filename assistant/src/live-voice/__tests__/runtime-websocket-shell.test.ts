import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => {
  const config = {
    model: "test",
    provider: "test",
    platform: { baseUrl: "https://example.com" },
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200_000 },
    services: {
      stt: { provider: "deepgram" },
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": {
        mode: "your-own",
        provider: "inference-provider-native",
      },
    },
  };
  return {
    loadConfig: () => config,
    getConfig: () => config,
    invalidateConfigCache: () => {},
  };
});

import { CURRENT_POLICY_EPOCH } from "../../runtime/auth/policy.js";
import { mintToken } from "../../runtime/auth/token-service.js";
import { RuntimeHttpServer } from "../../runtime/http-server.js";

type JsonFrame = Record<string, unknown>;

const savedAuthEnv = {
  DISABLE_HTTP_AUTH: process.env.DISABLE_HTTP_AUTH,
  VELLUM_UNSAFE_AUTH_BYPASS: process.env.VELLUM_UNSAFE_AUTH_BYPASS,
};

function mintGatewayToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

function mintActorToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "actor:self:user-123",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

function startFrame(conversationId = "conversation-123"): string {
  return JSON.stringify({
    type: "start",
    conversationId,
    audio: {
      mimeType: "audio/pcm",
      sampleRate: 24_000,
      channels: 1,
    },
  });
}

async function waitForOpen(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket open"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket failed to open"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

async function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket close failed"));
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

async function waitForJsonFrame(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<JsonFrame> {
  await waitForOpen(ws, timeoutMs);
  return await new Promise<JsonFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      cleanup();
      const data = event.data;
      if (typeof data !== "string") {
        reject(new Error("Expected text WebSocket message"));
        return;
      }
      resolve(JSON.parse(data) as JsonFrame);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before message"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket errored before message"));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

function closeClient(ws: WebSocket): void {
  if (
    ws.readyState === WebSocket.CONNECTING ||
    ws.readyState === WebSocket.OPEN
  ) {
    ws.close(1000, "test shutdown");
  }
}

describe("RuntimeHttpServer live voice WebSocket shell", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;
  let wsBaseUrl: string;
  let clients: WebSocket[];

  beforeEach(async () => {
    delete process.env.DISABLE_HTTP_AUTH;
    delete process.env.VELLUM_UNSAFE_AUTH_BYPASS;
    clients = [];
    const port = 21100 + Math.floor(Math.random() * 300);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.actualPort}`;
    wsBaseUrl = `ws://127.0.0.1:${server.actualPort}`;
  });

  afterEach(async () => {
    for (const client of clients) {
      closeClient(client);
    }
    await server.stop();
    if (savedAuthEnv.DISABLE_HTTP_AUTH === undefined) {
      delete process.env.DISABLE_HTTP_AUTH;
    } else {
      process.env.DISABLE_HTTP_AUTH = savedAuthEnv.DISABLE_HTTP_AUTH;
    }
    if (savedAuthEnv.VELLUM_UNSAFE_AUTH_BYPASS === undefined) {
      delete process.env.VELLUM_UNSAFE_AUTH_BYPASS;
    } else {
      process.env.VELLUM_UNSAFE_AUTH_BYPASS =
        savedAuthEnv.VELLUM_UNSAFE_AUTH_BYPASS;
    }
  });

  function openLiveVoiceClient(token = mintGatewayToken()): WebSocket {
    const ws = new WebSocket(
      `${wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(token)}`,
    );
    clients.push(ws);
    return ws;
  }

  test("rejects unauthorized upgrades before creating a WebSocket", async () => {
    const baseHeaders = {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    };

    const missingToken = await fetch(`${baseUrl}/v1/live-voice`, {
      headers: baseHeaders,
    });
    expect(missingToken.status).toBe(401);

    const actorToken = await fetch(
      `${baseUrl}/v1/live-voice?token=${mintActorToken()}`,
      { headers: baseHeaders },
    );
    expect(actorToken.status).toBe(401);

    const externalOrigin = await fetch(
      `${baseUrl}/v1/live-voice?token=${mintGatewayToken()}`,
      {
        headers: {
          ...baseHeaders,
          Origin: "https://external.example.com",
        },
      },
    );
    expect(externalOrigin.status).toBe(403);
  });

  test("sends ready for a well-formed start frame", async () => {
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send(startFrame("conversation-ready"));
    const ready = await waitForJsonFrame(ws);

    expect(ready).toMatchObject({
      type: "ready",
      seq: 1,
      conversationId: "conversation-ready",
    });
    expect(typeof ready.sessionId).toBe("string");
  });

  test("sends an error for malformed frames and can still start", async () => {
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send("{");
    const error = await waitForJsonFrame(ws);
    expect(error).toMatchObject({
      type: "error",
      seq: 1,
      code: "invalid_json",
    });

    ws.send(startFrame("conversation-after-error"));
    const ready = await waitForJsonFrame(ws);
    expect(ready).toMatchObject({
      type: "ready",
      conversationId: "conversation-after-error",
    });
    expect(typeof ready.sessionId).toBe("string");
  });

  test("releases the session lock when the WebSocket closes", async () => {
    const first = openLiveVoiceClient();
    const second = openLiveVoiceClient();
    await Promise.all([waitForOpen(first), waitForOpen(second)]);

    first.send(startFrame("conversation-first"));
    const firstReady = await waitForJsonFrame(first);
    expect(firstReady.type).toBe("ready");

    second.send(startFrame("conversation-second"));
    const busy = await waitForJsonFrame(second);
    expect(busy).toMatchObject({
      type: "busy",
      activeSessionId: firstReady.sessionId,
    });

    first.close(1000, "client finished");
    await waitForClose(first);

    second.send(startFrame("conversation-second"));
    const secondReady = await waitForJsonFrame(second);
    expect(secondReady).toMatchObject({
      type: "ready",
      conversationId: "conversation-second",
    });
    expect(secondReady.sessionId).not.toBe(firstReady.sessionId);
  });
});

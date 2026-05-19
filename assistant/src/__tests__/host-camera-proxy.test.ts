import { beforeEach, describe, expect, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
const registered: Array<{ requestId: string; interaction: unknown }> = [];
const resolvedInteractionIds: string[] = [];
let providerCalls = 0;

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_camera" ? { clientId: "client-1" } : null,
    listClientsByCapability: (cap: string) =>
      cap === "host_camera"
        ? [
            {
              clientId: "client-1",
              capabilities: ["host_camera"],
              actorPrincipalId: "actor-1",
            },
          ]
        : [],
    getClientById: (clientId: string) =>
      clientId === "client-1"
        ? { clientId, capabilities: ["host_camera"] }
        : null,
    getActorPrincipalIdForClient: (clientId: string) =>
      clientId === "client-1" ? "actor-1" : undefined,
  },
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: (requestId: string, interaction: unknown) => {
    registered.push({ requestId, interaction });
  },
  resolve: (requestId: string) => {
    resolvedInteractionIds.push(requestId);
    return undefined;
  },
  get: () => undefined,
  getByKind: () => [],
  getByConversation: () => [],
  removeByConversation: () => {},
}));

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: () => ({
    sendMessage: async () => {
      providerCalls += 1;
      return {
        content: [
          { type: "text", text: "A desk, a keyboard, and a mug are visible." },
        ],
        model: "mock",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end",
      };
    },
  }),
  extractAllText: (response: {
    content: Array<{ type: string; text?: string }>;
  }) =>
    response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
}));

import { HostCameraProxy } from "../daemon/host-camera-proxy.js";

describe("HostCameraProxy", () => {
  beforeEach(() => {
    sentMessages.length = 0;
    registered.length = 0;
    resolvedInteractionIds.length = 0;
    providerCalls = 0;
  });

  test("dispatches one host_camera_request and returns only the text summary", async () => {
    const proxy = new HostCameraProxy();
    const resultPromise = proxy.request(
      "describe_camera_once",
      { prompt: "What is on the desk?" },
      "conv-1",
      undefined,
      "actor-1",
    );

    const requestMessage = sentMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "host_camera_request",
    ) as Record<string, unknown>;
    expect(requestMessage).toBeDefined();
    expect(requestMessage.toolName).toBe("describe_camera_once");
    expect(requestMessage.conversationId).toBe("conv-1");
    expect(requestMessage.input).toEqual({ prompt: "What is on the desk?" });
    expect(requestMessage.targetClientId).toBe("client-1");
    expect(registered).toHaveLength(1);

    proxy.resolve(requestMessage.requestId as string, {
      requestId: requestMessage.requestId as string,
      imageBase64: "raw-image-bytes",
      mediaType: "image/jpeg",
      width: 640,
      height: 480,
    });

    const result = await resultPromise;
    expect(providerCalls).toBe(1);
    expect(result).toEqual({
      content: "A desk, a keyboard, and a mug are visible.",
      isError: false,
    });
    expect(JSON.stringify(result)).not.toContain("raw-image-bytes");
  });

  test("client errors are returned without calling the summarizer", async () => {
    const proxy = new HostCameraProxy();
    const resultPromise = proxy.request(
      "describe_camera_once",
      {},
      "conv-1",
      undefined,
      "actor-1",
    );
    const requestMessage = sentMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "host_camera_request",
    ) as Record<string, unknown>;

    proxy.resolve(requestMessage.requestId as string, {
      requestId: requestMessage.requestId as string,
      error: "Camera permission denied.",
    });

    await expect(resultPromise).resolves.toEqual({
      content: "Camera permission denied.",
      isError: true,
    });
    expect(providerCalls).toBe(0);
  });
});

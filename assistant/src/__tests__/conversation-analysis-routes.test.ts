import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const mockResolveConversationId = mock((id: string) => id);
const mockGetConversation = mock(() => ({
  id: "conv-1",
  title: "Source",
  conversationType: "normal",
}));
const mockGetMessages = mock(() => [{ id: "m-source" }]);
const mockCreateConversation = mock(() => ({ id: "analysis-1" }));
const mockAddMessage = mock(async () => ({ id: "msg-1" }));

mock.module("../memory/conversation-key-store.js", () => ({
  resolveConversationId: mockResolveConversationId,
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
}));

mock.module("../export/transcript-formatter.js", () => ({
  buildAnalysisTranscript: () => "user: hi",
}));

import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import type { SendMessageDeps } from "../runtime/http-types.js";
import { conversationAnalysisRouteDefinitions } from "../runtime/routes/conversation-analysis-routes.js";

beforeEach(() => {
  mockResolveConversationId.mockClear();
  mockGetConversation.mockClear();
  mockGetMessages.mockClear();
  mockCreateConversation.mockClear();
  mockAddMessage.mockClear();
});

function makeConversation() {
  return {
    setTrustContext: mock(() => {}),
    ensureActorScopedHistory: mock(() => Promise.resolve()),
    setSubagentAllowedTools: mock(() => {}),
    updateClient: mock(() => {}),
    processing: false,
    abortController: null as AbortController | null,
    currentRequestId: null as string | null,
    runAgentLoop: mock(() => Promise.resolve()),
  };
}

describe("POST /v1/conversations/:id/analyze", () => {
  test("runs headless analysis with unknown trust and no tools when no subscriber is present", async () => {
    const conversation = makeConversation();
    const assistantEventHub = new AssistantEventHub();
    const sendMessageDeps = {
      getOrCreateConversation: mock(async () => conversation),
      assistantEventHub,
      resolveAttachments: () => [],
    } as unknown as SendMessageDeps;

    const routes = conversationAnalysisRouteDefinitions({
      sendMessageDeps,
      buildConversationDetailResponse: () => ({ id: "analysis-1" }),
    });
    const route = routes.find(
      (r) => r.method === "POST" && r.endpoint === "conversations/:id/analyze",
    );
    if (!route) throw new Error("analyze route missing");

    const req = new Request("http://localhost/v1/conversations/conv-1/analyze", {
      method: "POST",
    });

    const res = await route.handler({
      req,
      url: new URL(req.url),
      server: null as never,
      authContext: {} as never,
      params: { id: "conv-1" },
    });

    expect(res.status).toBe(200);
    expect(mockAddMessage).toHaveBeenCalledWith(
      "analysis-1",
      "user",
      expect.any(String),
      { provenanceTrustClass: "unknown" },
    );
    expect(conversation.setTrustContext).toHaveBeenCalledWith({
      trustClass: "unknown",
      sourceChannel: "vellum",
    });
    expect(conversation.ensureActorScopedHistory).toHaveBeenCalledTimes(1);
    expect(conversation.setSubagentAllowedTools).toHaveBeenCalledTimes(1);
    const allowedTools = (
      conversation.setSubagentAllowedTools.mock.calls as unknown as Array<
        [Set<string> | undefined]
      >
    )[0]?.[0];
    expect(allowedTools).toBeInstanceOf(Set);
    expect(allowedTools?.size).toBe(0);
    expect(conversation.updateClient).toHaveBeenCalledWith(
      expect.any(Function),
      true,
    );
    expect(conversation.runAgentLoop).toHaveBeenCalledWith(
      expect.any(String),
      "msg-1",
      expect.any(Function),
      expect.objectContaining({ isInteractive: false, isUserMessage: true }),
    );
  });

  test("keeps analysis non-interactive even when a matching subscriber is connected", async () => {
    const conversation = makeConversation();
    const assistantEventHub = new AssistantEventHub();
    assistantEventHub.subscribe(
      { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
      () => {},
    );
    const sendMessageDeps = {
      getOrCreateConversation: mock(async () => conversation),
      assistantEventHub,
      resolveAttachments: () => [],
    } as unknown as SendMessageDeps;

    const routes = conversationAnalysisRouteDefinitions({
      sendMessageDeps,
      buildConversationDetailResponse: () => ({ id: "analysis-1" }),
    });
    const route = routes.find(
      (r) => r.method === "POST" && r.endpoint === "conversations/:id/analyze",
    );
    if (!route) throw new Error("analyze route missing");

    const req = new Request("http://localhost/v1/conversations/conv-1/analyze", {
      method: "POST",
    });

    await route.handler({
      req,
      url: new URL(req.url),
      server: null as never,
      authContext: {} as never,
      params: { id: "conv-1" },
    });

    expect(conversation.updateClient).toHaveBeenCalledWith(
      expect.any(Function),
      false,
    );
    expect(conversation.runAgentLoop).toHaveBeenCalledWith(
      expect.any(String),
      "msg-1",
      expect.any(Function),
      expect.objectContaining({ isInteractive: false, isUserMessage: true }),
    );
  });
});

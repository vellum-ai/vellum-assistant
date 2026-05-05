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

mock.module("../runtime/services/conversation-serializer.js", () => ({
  buildConversationDetailResponse: (id: string) => ({ id }),
}));

import {
  AssistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import { ROUTES } from "../runtime/routes/conversation-analysis-routes.js";

const analyzeRoute = ROUTES.find(
  (r) => r.operationId === "analyzeConversation",
)!;

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

// Mock getOrCreateConversation at the module level so analyzeConversation
// imports it directly (no DI singleton).
let mockConversation: ReturnType<typeof makeConversation>;

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async () => mockConversation,
}));

// Mock the assistantEventHub singleton
const testHub = new AssistantEventHub();
mock.module("../runtime/assistant-event-hub.js", () => ({
  AssistantEventHub,
  assistantEventHub: testHub,
}));

beforeEach(() => {
  mockResolveConversationId.mockClear();
  mockGetConversation.mockClear();
  mockGetMessages.mockClear();
  mockCreateConversation.mockClear();
  mockAddMessage.mockClear();
  mockConversation = makeConversation();
});

describe("POST /v1/conversations/:id/analyze", () => {
  test("runs headless analysis with unknown trust and no tools when no subscriber is present", async () => {
    const result = await analyzeRoute.handler({
      pathParams: { id: "conv-1" },
    });

    expect(result).toEqual({ id: "analysis-1" });
    expect(mockAddMessage).toHaveBeenCalledWith(
      "analysis-1",
      "user",
      expect.any(String),
      { provenanceTrustClass: "unknown" },
    );
    expect(mockConversation.setTrustContext).toHaveBeenCalledWith({
      trustClass: "unknown",
      sourceChannel: "vellum",
    });
    expect(mockConversation.ensureActorScopedHistory).toHaveBeenCalledTimes(1);
    expect(mockConversation.setSubagentAllowedTools).toHaveBeenCalledTimes(1);
    const allowedTools = (
      mockConversation.setSubagentAllowedTools.mock.calls as unknown as Array<
        [Set<string> | undefined]
      >
    )[0]?.[0];
    expect(allowedTools).toBeInstanceOf(Set);
    expect(allowedTools?.size).toBe(0);
    expect(mockConversation.updateClient).toHaveBeenCalledWith(
      broadcastMessage,
      true,
    );
    expect(mockConversation.runAgentLoop).toHaveBeenCalledWith(
      expect.any(String),
      "msg-1",
      undefined,
      expect.objectContaining({ isInteractive: false, isUserMessage: true }),
    );
  });

  test("keeps analysis non-interactive even when a matching subscriber is connected", async () => {
    const sub = testHub.subscribe({
      type: "process",
      callback: () => {},
    });

    try {
      await analyzeRoute.handler({
        pathParams: { id: "conv-1" },
      });

      expect(mockConversation.updateClient).toHaveBeenCalledWith(
        broadcastMessage,
        false,
      );
      expect(mockConversation.runAgentLoop).toHaveBeenCalledWith(
        expect.any(String),
        "msg-1",
        undefined,
        expect.objectContaining({ isInteractive: false, isUserMessage: true }),
      );
    } finally {
      sub.dispose();
    }
  });
});

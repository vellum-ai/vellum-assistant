/**
 * Unit tests for the analyzeConversation service.
 *
 * The service is driven directly (no HTTP routing) so tests exercise the
 * validation + setup logic against mocked memory/CRUD + transcript helpers.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const mockResolveConversationId = mock((id: string) => id as string | null);
const mockGetConversation = mock(
  () =>
    ({
      id: "conv-1",
      title: "Source",
      conversationType: "normal",
    }) as Record<string, unknown> | null,
);
const mockGetMessages = mock(() => [{ id: "m-source" }] as Array<{ id: string }>);
const mockCreateConversation = mock(() => ({ id: "analysis-1" }));
const mockAddMessage = mock(async () => ({ id: "msg-1" }));

mock.module("../../../memory/conversation-key-store.js", () => ({
  resolveConversationId: mockResolveConversationId,
}));

mock.module("../../../memory/conversation-crud.js", () => ({
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
}));

mock.module("../../../export/transcript-formatter.js", () => ({
  buildAnalysisTranscript: () => "user: hi",
}));

import { AssistantEventHub } from "../../assistant-event-hub.js";
import type { SendMessageDeps } from "../../http-types.js";
import { analyzeConversation } from "../analyze-conversation.js";

beforeEach(() => {
  mockResolveConversationId.mockReset();
  mockResolveConversationId.mockImplementation((id: string) => id);
  mockGetConversation.mockReset();
  mockGetConversation.mockImplementation(() => ({
    id: "conv-1",
    title: "Source",
    conversationType: "normal",
  }));
  mockGetMessages.mockReset();
  mockGetMessages.mockImplementation(() => [{ id: "m-source" }]);
  mockCreateConversation.mockReset();
  mockCreateConversation.mockImplementation(() => ({ id: "analysis-1" }));
  mockAddMessage.mockReset();
  mockAddMessage.mockImplementation(async () => ({ id: "msg-1" }));
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

function makeDeps(conversation: ReturnType<typeof makeConversation>) {
  const assistantEventHub = new AssistantEventHub();
  const sendMessageDeps = {
    getOrCreateConversation: mock(async () => conversation),
    assistantEventHub,
    resolveAttachments: () => [],
  } as unknown as SendMessageDeps;
  return {
    sendMessageDeps,
    buildConversationDetailResponse: (id: string) => ({ id }),
  };
}

describe("analyzeConversation", () => {
  test("returns NOT_FOUND when the source ID does not resolve", async () => {
    mockResolveConversationId.mockImplementation(() => null);
    const deps = makeDeps(makeConversation());

    const result = await analyzeConversation("missing", deps, {
      trigger: "manual",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("NOT_FOUND");
    expect(result.error.status).toBe(404);
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  test("returns NOT_FOUND when the conversation record is missing", async () => {
    mockGetConversation.mockImplementation(() => null);
    const deps = makeDeps(makeConversation());

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "manual",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("NOT_FOUND");
    expect(result.error.status).toBe(404);
  });

  test("returns FORBIDDEN when the source conversation is private", async () => {
    mockGetConversation.mockImplementation(() => ({
      id: "conv-1",
      title: "Private",
      conversationType: "private",
    }));
    const deps = makeDeps(makeConversation());

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "manual",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("FORBIDDEN");
    expect(result.error.status).toBe(403);
  });

  test("returns BAD_REQUEST when the source conversation has no messages", async () => {
    mockGetMessages.mockImplementation(() => []);
    const deps = makeDeps(makeConversation());

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "manual",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("BAD_REQUEST");
    expect(result.error.status).toBe(400);
  });

  test("creates an analysis conversation with unknown trust, no tools, and returns the new ID", async () => {
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "manual",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-1");

    // Persists the prompt as a user message with unknown trust.
    expect(mockAddMessage).toHaveBeenCalledWith(
      "analysis-1",
      "user",
      expect.any(String),
      { provenanceTrustClass: "unknown" },
    );

    // Sets trust context to unknown.
    expect(conversation.setTrustContext).toHaveBeenCalledWith({
      trustClass: "unknown",
      sourceChannel: "vellum",
    });

    // Strips all tools.
    expect(conversation.setSubagentAllowedTools).toHaveBeenCalledTimes(1);
    const allowedTools = (
      conversation.setSubagentAllowedTools.mock.calls as unknown as Array<
        [Set<string> | undefined]
      >
    )[0]?.[0];
    expect(allowedTools).toBeInstanceOf(Set);
    expect(allowedTools?.size).toBe(0);

    // Fires the agent loop.
    expect(conversation.runAgentLoop).toHaveBeenCalledWith(
      expect.any(String),
      "msg-1",
      expect.any(Function),
      expect.objectContaining({ isInteractive: false, isUserMessage: true }),
    );
  });
});

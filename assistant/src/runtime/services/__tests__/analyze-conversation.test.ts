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
      conversationType: "standard",
    }) as Record<string, unknown> | null,
);
const mockGetMessages = mock(
  () => [{ id: "m-source" }] as Array<{ id: string }>,
);
const mockCreateConversation = mock((_opts?: Record<string, unknown>) => ({
  id: "analysis-new",
}));
// Echo back the caller-supplied row id (the request id, under the
// requestId-as-row-id invariant) so tests can assert the persisted message
// row id matches the turn's request id. Falls back to "msg-1" when no id is
// passed.
const mockAddMessage = mock(
  async (
    _conversationId: string,
    _role: string,
    _content: string,
    opts?: { id?: string },
  ) => ({ id: opts?.id ?? "msg-1" }),
);
const mockFindAnalysisConversationFor = mock(
  (_parent: string) => null as { id: string } | null,
);
const mockGetConversationSource = mock((_id: string) => null as string | null);

mock.module("../../../memory/conversation-key-store.js", () => ({
  resolveConversationId: mockResolveConversationId,
}));

mock.module("../../../persistence/conversation-crud.js", () => ({
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  findAnalysisConversationFor: mockFindAnalysisConversationFor,
  getConversationSource: mockGetConversationSource,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../../export/transcript-formatter.js", () => ({
  buildAnalysisTranscript: () => "user: hi",
}));

// Mock the direct imports the service now uses instead of DI deps.
function makeConversation() {
  return {
    setTrustContext: mock(() => {}),
    ensureActorScopedHistory: mock(() => Promise.resolve()),
    setSubagentAllowedTools: mock(() => {}),
    updateClient: mock(() => {}),
    processing: false,
    isProcessing(this: { processing: boolean }) {
      return this.processing;
    },
    setProcessing(this: { processing: boolean }, value: boolean) {
      this.processing = value;
    },
    abortController: null as AbortController | null,
    currentRequestId: null as string | null,
    loadedHistoryTrustClass: undefined as string | undefined,
    runAgentLoop: mock(() => Promise.resolve()),
  };
}

let currentConversation = makeConversation();
const mockGetOrCreateConversation = mock(async () => currentConversation);

mock.module("../../../daemon/conversation-store.js", () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
}));

import { AssistantEventHub } from "../../assistant-event-hub.js";

const testHub = new AssistantEventHub();
mock.module("../../assistant-event-hub.js", () => ({
  AssistantEventHub,
  assistantEventHub: testHub,
  broadcastMessage: async () => {},
}));

import { analyzeConversation } from "../analyze-conversation.js";

beforeEach(() => {
  mockResolveConversationId.mockReset();
  mockResolveConversationId.mockImplementation((id: string) => id);
  mockGetConversation.mockReset();
  mockGetConversation.mockImplementation(() => ({
    id: "conv-1",
    title: "Source",
    conversationType: "standard",
  }));
  mockGetMessages.mockReset();
  mockGetMessages.mockImplementation(() => [{ id: "m-source" }]);
  mockCreateConversation.mockReset();
  mockCreateConversation.mockImplementation(() => ({ id: "analysis-new" }));
  mockAddMessage.mockReset();
  mockAddMessage.mockImplementation(
    async (
      _conversationId: string,
      _role: string,
      _content: string,
      opts?: { id?: string },
    ) => ({ id: opts?.id ?? "msg-1" }),
  );
  mockFindAnalysisConversationFor.mockReset();
  mockFindAnalysisConversationFor.mockImplementation(() => null);
  mockGetConversationSource.mockReset();
  mockGetConversationSource.mockImplementation(() => null);
  mockGetOrCreateConversation.mockReset();
  currentConversation = makeConversation();
  mockGetOrCreateConversation.mockImplementation(
    async () => currentConversation,
  );
});

describe("analyzeConversation", () => {
  test("returns NOT_FOUND when the source ID does not resolve", async () => {
    mockResolveConversationId.mockImplementation(() => null);

    const result = await analyzeConversation("missing", {
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

    const result = await analyzeConversation("conv-1", {
      trigger: "manual",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("NOT_FOUND");
    expect(result.error.status).toBe(404);
  });

  test("returns BAD_REQUEST when the source conversation has no messages", async () => {
    mockGetMessages.mockImplementation(() => []);

    const result = await analyzeConversation("conv-1", {
      trigger: "manual",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("BAD_REQUEST");
    expect(result.error.status).toBe(400);
  });

  test("creates an analysis conversation with unknown trust, no tools, and returns the new ID", async () => {
    const result = await analyzeConversation("conv-1", {
      trigger: "manual",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-new");

    // Persists the prompt as a user message with unknown trust, under a
    // caller-minted row id (the turn's request id).
    expect(mockAddMessage).toHaveBeenCalledWith(
      "analysis-new",
      "user",
      expect.any(String),
      { id: expect.any(String), metadata: { provenanceTrustClass: "unknown" } },
    );

    // Sets trust context to unknown.
    expect(currentConversation.setTrustContext).toHaveBeenCalledWith({
      trustClass: "unknown",
      sourceChannel: "vellum",
    });

    // Strips all tools.
    expect(currentConversation.setSubagentAllowedTools).toHaveBeenCalledTimes(
      1,
    );
    const allowedTools = (
      currentConversation.setSubagentAllowedTools.mock
        .calls as unknown as Array<[Set<string> | undefined]>
    )[0]?.[0];
    expect(allowedTools).toBeInstanceOf(Set);
    expect(allowedTools?.size).toBe(0);

    // requestId === userMessageId invariant: the id the prompt row was
    // persisted under, the turn's currentRequestId, and the userMessageId
    // handed to the agent loop are all the same value.
    const persistedId = (
      mockAddMessage.mock.calls as unknown as Array<
        [string, string, string, { id?: string } | undefined]
      >
    )[0]?.[3]?.id;
    expect(typeof persistedId).toBe("string");
    expect(currentConversation.currentRequestId).toBe(persistedId);

    // Fires the agent loop with the analyzeConversation call-site so the
    // per-call provider config flows through `resolveCallSiteConfig`, keying
    // the loop off the same id as userMessageId.
    expect(currentConversation.runAgentLoop).toHaveBeenCalledWith(
      expect.any(String),
      persistedId,
      expect.objectContaining({
        isInteractive: false,
        isUserMessage: true,
        callSite: "analyzeConversation",
      }),
    );
  });

  // ── Auto trigger ──────────────────────────────────────────────────

  test("auto: creates a new analysis conversation when none exists, with source=auto-analysis, dedicated groupId, and forkParentConversationId", async () => {
    mockFindAnalysisConversationFor.mockImplementation(() => null);

    const result = await analyzeConversation("conv-1", {
      trigger: "auto",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-new");

    // Verifies the rolling-analysis lookup was consulted against the source ID.
    expect(mockFindAnalysisConversationFor).toHaveBeenCalledWith("conv-1");

    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Analysis: Source",
        source: "auto-analysis",
        groupId: "system:background",
        forkParentConversationId: "conv-1",
      }),
    );
  });

  test("auto: skips the run (no agent loop, no message persisted) when the rolling analysis conversation is already processing", async () => {
    currentConversation.processing = true;

    const result = await analyzeConversation("conv-1", {
      trigger: "auto",
    });

    // Returns a successful no-op result tagged with `skipped: true`.
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-new");
    expect(result.skipped).toBe(true);

    // Critically, none of the mutating side effects should have run: no
    // message persisted, no trust context overwritten, no agent loop fired.
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(currentConversation.setTrustContext).not.toHaveBeenCalled();
    expect(currentConversation.runAgentLoop).not.toHaveBeenCalled();
    expect(currentConversation.abortController).toBeNull();
  });

  test("manual: does NOT skip when the conversation reports processing (guard is auto-only)", async () => {
    currentConversation.processing = true;

    const result = await analyzeConversation("conv-1", {
      trigger: "manual",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.skipped).toBeUndefined();

    // Manual trigger always proceeds — it creates a fresh conversation per
    // invocation, so there is no shared-state concurrency hazard.
    expect(mockAddMessage).toHaveBeenCalled();
    expect(currentConversation.runAgentLoop).toHaveBeenCalled();
  });

  test("auto: reuses an existing rolling analysis conversation (no new row)", async () => {
    mockFindAnalysisConversationFor.mockImplementation(() => ({
      id: "analysis-existing",
    }));

    const result = await analyzeConversation("conv-1", {
      trigger: "auto",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-existing");

    // No new conversation row is created on reuse.
    expect(mockCreateConversation).not.toHaveBeenCalled();

    // The new user message is appended to the existing analysis conversation,
    // persisted under the turn's request id.
    expect(mockAddMessage).toHaveBeenCalledWith(
      "analysis-existing",
      "user",
      expect.any(String),
      {
        id: expect.any(String),
        metadata: { provenanceTrustClass: "guardian" },
      },
    );
  });

  test("auto: invalidates loadedHistoryTrustClass before ensureActorScopedHistory on reuse so stale ctx.messages is reloaded", async () => {
    // Simulate a reused rolling conversation whose prior run already cached
    // a guardian-class history load. Without explicit invalidation,
    // ensureActorScopedHistory would short-circuit and runAgentLoopImpl
    // would execute against ctx.messages missing the newly-enqueued prompt.
    mockFindAnalysisConversationFor.mockImplementation(() => ({
      id: "analysis-existing",
    }));
    currentConversation.loadedHistoryTrustClass = "guardian";
    let trustClassWhenEnsured: string | undefined = "sentinel";
    currentConversation.ensureActorScopedHistory.mockImplementation(() => {
      trustClassWhenEnsured = currentConversation.loadedHistoryTrustClass;
      return Promise.resolve();
    });

    const result = await analyzeConversation("conv-1", {
      trigger: "auto",
    });

    expect("error" in result).toBe(false);
    // The invalidation must land before ensureActorScopedHistory runs so
    // the reload inside it pulls the freshly-persisted user prompt.
    expect(trustClassWhenEnsured).toBeUndefined();
    expect(currentConversation.ensureActorScopedHistory).toHaveBeenCalledTimes(
      1,
    );
  });

  test("auto: sets trustClass to guardian", async () => {
    const result = await analyzeConversation("conv-1", {
      trigger: "auto",
    });
    expect("error" in result).toBe(false);

    expect(currentConversation.setTrustContext).toHaveBeenCalledWith({
      trustClass: "guardian",
      sourceChannel: "vellum",
    });
  });

  test("auto: does NOT strip the tool surface", async () => {
    const result = await analyzeConversation("conv-1", {
      trigger: "auto",
    });
    expect("error" in result).toBe(false);

    // Manual mode calls this with an empty Set; auto mode must leave the
    // conversation's default tool surface intact.
    expect(currentConversation.setSubagentAllowedTools).not.toHaveBeenCalled();
  });

  test("auto: rejects when the source conversation is itself an auto-analysis conversation", async () => {
    mockGetConversationSource.mockImplementation(() => "auto-analysis");

    const result = await analyzeConversation("conv-1", {
      trigger: "auto",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.kind).toBe("BAD_REQUEST");
    expect(result.error.status).toBe(400);

    // Nothing downstream of the guard should have fired.
    expect(mockFindAnalysisConversationFor).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  test.each(["memory-retrospective", "memory-retrospective-fork"])(
    "auto: rejects when the source conversation is a %s conversation",
    async (source) => {
      // Fork-kind retrospective conversations carry a full copy of the
      // source conversation's history; auto-analyzing one would re-process
      // the entire source conversation and double-write memory.
      mockGetConversationSource.mockImplementation(() => source);

      const result = await analyzeConversation("conv-1", {
        trigger: "auto",
      });

      expect("error" in result).toBe(true);
      if (!("error" in result)) throw new Error("expected error");
      expect(result.error.kind).toBe("BAD_REQUEST");
      expect(result.error.status).toBe(400);

      // Nothing downstream of the guard should have fired.
      expect(mockFindAnalysisConversationFor).not.toHaveBeenCalled();
      expect(mockCreateConversation).not.toHaveBeenCalled();
      expect(mockAddMessage).not.toHaveBeenCalled();
    },
  );

  test("manual: does NOT reject a memory-retrospective conversation (guard is auto-only)", async () => {
    mockGetConversationSource.mockImplementation(
      () => "memory-retrospective-fork",
    );

    const result = await analyzeConversation("conv-1", {
      trigger: "manual",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-new");
  });

  test("auto: routes the agent loop through callSite: 'analyzeConversation'", async () => {
    await analyzeConversation("conv-1", { trigger: "auto" });

    // Same requestId === userMessageId invariant on the auto path: the row
    // id the prompt was persisted under, currentRequestId, and the loop's
    // userMessageId are the same value.
    const persistedId = (
      mockAddMessage.mock.calls as unknown as Array<
        [string, string, string, { id?: string } | undefined]
      >
    )[0]?.[3]?.id;
    expect(typeof persistedId).toBe("string");
    expect(currentConversation.currentRequestId).toBe(persistedId);
    expect(currentConversation.runAgentLoop).toHaveBeenCalledWith(
      expect.any(String),
      persistedId,
      expect.objectContaining({ callSite: "analyzeConversation" }),
    );
  });

  test("does not thread modelIntent/modelOverride into getOrCreateConversation", async () => {
    // Per-call model selection now happens via the call-site resolver against
    // `llm.callSites.analyzeConversation`, not via legacy modelIntent/
    // modelOverride keys on the conversation create options.
    await analyzeConversation("conv-1", { trigger: "auto" });

    const calls = mockGetOrCreateConversation.mock.calls as unknown as Array<
      [string, Record<string, unknown> | undefined]
    >;
    expect(calls.length).toBe(1);
    const passedOpts = calls[0]?.[1];
    if (passedOpts !== undefined) {
      expect("modelIntent" in passedOpts).toBe(false);
      expect("modelOverride" in passedOpts).toBe(false);
    }
  });
});

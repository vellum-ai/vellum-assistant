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
const mockCreateConversation = mock(
  (_opts?: Record<string, unknown>) => ({ id: "analysis-new" }),
);
const mockAddMessage = mock(async () => ({ id: "msg-1" }));
const mockFindAnalysisConversationFor = mock(
  (_parent: string) => null as { id: string } | null,
);
const mockGetConversationSource = mock((_id: string) => null as string | null);

mock.module("../../../memory/conversation-key-store.js", () => ({
  resolveConversationId: mockResolveConversationId,
}));

mock.module("../../../memory/conversation-crud.js", () => ({
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  findAnalysisConversationFor: mockFindAnalysisConversationFor,
  getConversationSource: mockGetConversationSource,
}));

mock.module("../../../export/transcript-formatter.js", () => ({
  buildAnalysisTranscript: () => "user: hi",
}));

// Default config stub — individual tests can override via mockGetConfig.
interface AnalysisConfigStub {
  analysis: {
    modelIntent?: string;
    modelOverride?: string;
  };
}
const mockGetConfig = mock(
  (): AnalysisConfigStub => ({
    analysis: {},
  }),
);

mock.module("../../../config/loader.js", () => ({
  getConfig: mockGetConfig,
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
  mockCreateConversation.mockImplementation(() => ({ id: "analysis-new" }));
  mockAddMessage.mockReset();
  mockAddMessage.mockImplementation(async () => ({ id: "msg-1" }));
  mockFindAnalysisConversationFor.mockReset();
  mockFindAnalysisConversationFor.mockImplementation(() => null);
  mockGetConversationSource.mockReset();
  mockGetConversationSource.mockImplementation(() => null);
  mockGetConfig.mockReset();
  mockGetConfig.mockImplementation(() => ({ analysis: {} }));
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
    loadedHistoryTrustClass: undefined as string | undefined,
    runAgentLoop: mock(() => Promise.resolve()),
  };
}

function makeDeps(conversation: ReturnType<typeof makeConversation>) {
  const assistantEventHub = new AssistantEventHub();
  const getOrCreateConversation = mock(async () => conversation);
  const sendMessageDeps = {
    getOrCreateConversation,
    assistantEventHub,
    resolveAttachments: () => [],
  } as unknown as SendMessageDeps;
  return {
    sendMessageDeps,
    buildConversationDetailResponse: (id: string) => ({ id }),
    getOrCreateConversation,
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
    expect(result.analysisConversationId).toBe("analysis-new");

    // Persists the prompt as a user message with unknown trust.
    expect(mockAddMessage).toHaveBeenCalledWith(
      "analysis-new",
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

  // ── Auto trigger ──────────────────────────────────────────────────

  test("auto: creates a new analysis conversation when none exists, with source=auto-analysis, dedicated groupId, and forkParentConversationId", async () => {
    mockFindAnalysisConversationFor.mockImplementation(() => null);
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "auto",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-new");

    // Verifies the rolling-analysis lookup was consulted against the source ID.
    expect(mockFindAnalysisConversationFor).toHaveBeenCalledWith("conv-1");

    // Created exactly one new conversation row, with the expected shape.
    // The dedicated `system:reflections` group keeps rolling analysis
    // conversations out of the default `system:all` group used by clients
    // that do not filter on `source`.
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Analysis: Source",
        source: "auto-analysis",
        groupId: "system:reflections",
        forkParentConversationId: "conv-1",
      }),
    );
  });

  test("auto: skips the run (no agent loop, no message persisted) when the rolling analysis conversation is already processing", async () => {
    const conversation = makeConversation();
    conversation.processing = true;
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
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
    expect(conversation.setTrustContext).not.toHaveBeenCalled();
    expect(conversation.runAgentLoop).not.toHaveBeenCalled();
    expect(conversation.abortController).toBeNull();
  });

  test("manual: does NOT skip when the conversation reports processing (guard is auto-only)", async () => {
    const conversation = makeConversation();
    conversation.processing = true;
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "manual",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.skipped).toBeUndefined();

    // Manual trigger always proceeds — it creates a fresh conversation per
    // invocation, so there is no shared-state concurrency hazard.
    expect(mockAddMessage).toHaveBeenCalled();
    expect(conversation.runAgentLoop).toHaveBeenCalled();
  });

  test("auto: reuses an existing rolling analysis conversation (no new row)", async () => {
    mockFindAnalysisConversationFor.mockImplementation(() => ({
      id: "analysis-existing",
    }));
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "auto",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.analysisConversationId).toBe("analysis-existing");

    // No new conversation row is created on reuse.
    expect(mockCreateConversation).not.toHaveBeenCalled();

    // The new user message is appended to the existing analysis conversation.
    expect(mockAddMessage).toHaveBeenCalledWith(
      "analysis-existing",
      "user",
      expect.any(String),
      { provenanceTrustClass: "guardian" },
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
    const conversation = makeConversation();
    conversation.loadedHistoryTrustClass = "guardian";
    let trustClassWhenEnsured: string | undefined = "sentinel";
    conversation.ensureActorScopedHistory.mockImplementation(() => {
      trustClassWhenEnsured = conversation.loadedHistoryTrustClass;
      return Promise.resolve();
    });
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "auto",
    });

    expect("error" in result).toBe(false);
    // The invalidation must land before ensureActorScopedHistory runs so
    // the reload inside it pulls the freshly-persisted user prompt.
    expect(trustClassWhenEnsured).toBeUndefined();
    expect(conversation.ensureActorScopedHistory).toHaveBeenCalledTimes(1);
  });

  test("auto: sets trustClass to guardian", async () => {
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "auto",
    });
    expect("error" in result).toBe(false);

    expect(conversation.setTrustContext).toHaveBeenCalledWith({
      trustClass: "guardian",
      sourceChannel: "vellum",
    });
  });

  test("auto: does NOT strip the tool surface", async () => {
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
      trigger: "auto",
    });
    expect("error" in result).toBe(false);

    // Manual mode calls this with an empty Set; auto mode must leave the
    // conversation's default tool surface intact.
    expect(conversation.setSubagentAllowedTools).not.toHaveBeenCalled();
  });

  test("auto: rejects when the source conversation is itself an auto-analysis conversation", async () => {
    mockGetConversationSource.mockImplementation(() => "auto-analysis");
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    const result = await analyzeConversation("conv-1", deps, {
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

  test("auto: passes modelOverride through to getOrCreateConversation when set in config", async () => {
    mockGetConfig.mockImplementation(() => ({
      analysis: {
        modelIntent: "quality-optimized",
        modelOverride: "claude-opus-4-6",
      },
    }));
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    await analyzeConversation("conv-1", deps, { trigger: "auto" });

    expect(deps.getOrCreateConversation).toHaveBeenCalledWith(
      "analysis-new",
      expect.objectContaining({
        modelIntent: "quality-optimized",
        modelOverride: "claude-opus-4-6",
      }),
    );
  });

  test("auto: does not pass modelOverride/modelIntent keys when config leaves them unset", async () => {
    const conversation = makeConversation();
    const deps = makeDeps(conversation);

    await analyzeConversation("conv-1", deps, { trigger: "auto" });

    const [, passedOpts] = (
      deps.getOrCreateConversation.mock.calls as unknown as Array<
        [string, Record<string, unknown>]
      >
    )[0] ?? ["", {}];
    expect(passedOpts).toBeDefined();
    expect("modelIntent" in (passedOpts ?? {})).toBe(false);
    expect("modelOverride" in (passedOpts ?? {})).toBe(false);
  });
});

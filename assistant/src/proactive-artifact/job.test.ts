import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock state ──────────────────────────────────────────────────────────

// Provider mock
let decisionProviderAvailable = true;
let buildProviderAvailable = true;
let decisionResponse = "";
let buildResponse = "";
let copyResponse = "";
let providerSendCalls: Array<{ callSite: string; messages: unknown[] }> = [];

const mockProvider = (callSite: string) => ({
  name: "mock-provider",
  sendMessage: async (messages: unknown[]) => {
    providerSendCalls.push({ callSite, messages });
    if (callSite === "proactiveArtifactDecision") {
      return { content: [{ type: "text", text: decisionResponse }] };
    }
    if (callSite === "proactiveArtifactBuild") {
      // copyResponse is used when it's for message copy (second call)
      const isCopyCall = providerSendCalls.filter(
        (c) => c.callSite === "proactiveArtifactBuild",
      ).length;
      if (isCopyCall > 1) {
        return { content: [{ type: "text", text: copyResponse }] };
      }
      return { content: [{ type: "text", text: buildResponse }] };
    }
    return { content: [{ type: "text", text: "" }] };
  },
});

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async (callSite: string) => {
    if (
      callSite === "proactiveArtifactDecision" &&
      !decisionProviderAvailable
    ) {
      return null;
    }
    if (callSite === "proactiveArtifactBuild" && !buildProviderAvailable) {
      return null;
    }
    return mockProvider(callSite);
  },
  extractText: (response: { content: Array<{ type: string; text: string }> }) =>
    response.content.find((b: { type: string }) => b.type === "text")?.text ??
    "",
}));

// rawAll mock
let rawAllRows: Array<{ role: string; content: string }> = [];

mock.module("../memory/raw-query.js", () => ({
  rawAll: () => rawAllRows,
  rawRun: () => 0,
}));

// bootstrapConversation mock
let bootstrapCalls: Array<Record<string, unknown>> = [];

mock.module("../memory/conversation-bootstrap.js", () => ({
  bootstrapConversation: (opts: Record<string, unknown>) => {
    bootstrapCalls.push(opts);
    return { id: `bg-conv-${bootstrapCalls.length}` };
  },
}));

// processMessage mock
let processMessageCalls: Array<{
  conversationId: string;
  prompt: string;
  options: unknown;
}> = [];
let processMessageShouldThrow = false;

mock.module("../daemon/process-message.js", () => ({
  processMessage: async (
    conversationId: string,
    prompt: string,
    _attachmentIds: unknown,
    options: unknown,
  ) => {
    processMessageCalls.push({ conversationId, prompt, options });
    if (processMessageShouldThrow) {
      throw new Error("processMessage failed");
    }
    return { messageId: "pm-msg-1" };
  },
}));

// App store mock
let mockApps: Array<{
  id: string;
  name: string;
  createdAt: number;
  updatedAt?: number;
  conversationIds?: string[];
}> = [];
let addAppConvCalls: Array<{ appId: string; conversationId: string }> = [];

mock.module("../memory/app-store.js", () => ({
  listApps: () => mockApps,
  listAppsByConversation: (conversationId: string) =>
    mockApps.filter((app) => app.conversationIds?.includes(conversationId)),
  addAppConversationId: (appId: string, conversationId: string) => {
    addAppConvCalls.push({ appId, conversationId });
    return true;
  },
}));

// Document store mock
let saveDocumentCalls: Array<Record<string, unknown>> = [];
let saveDocumentResult: {
  success: boolean;
  surfaceId?: string;
  error?: string;
} = {
  success: true,
  surfaceId: "doc-123",
};
let addDocConvCalls: Array<{ surfaceId: string; conversationId: string }> = [];

mock.module("../documents/document-store.js", () => ({
  saveDocument: (params: Record<string, unknown>) => {
    saveDocumentCalls.push(params);
    return saveDocumentResult;
  },
  addDocumentConversation: (surfaceId: string, conversationId: string) => {
    addDocConvCalls.push({ surfaceId, conversationId });
  },
}));

// addMessage mock
let addMessageCalls: Array<{
  conversationId: string;
  role: string;
  content: string;
  metadata: unknown;
  opts: unknown;
}> = [];

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    metadata: unknown,
    opts: unknown,
  ) => {
    addMessageCalls.push({ conversationId, role, content, metadata, opts });
    return { id: `msg-${addMessageCalls.length}` };
  },
}));

// emitNotificationSignal mock
let emitSignalCalls: Array<Record<string, unknown>> = [];

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: "signal-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
}));

// findConversation mock
type MockConversation = {
  processing: boolean;
  messages: unknown[];
  getMessages: () => unknown[];
};
let mockConversations: Map<string, MockConversation> = new Map();

mock.module("../daemon/conversation-store.js", () => ({
  findConversation: (id: string) => mockConversations.get(id),
}));

// createAssistantMessage mock
mock.module("../agent/message-types.js", () => ({
  createAssistantMessage: (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
  }),
}));

// Trigger state mock
let releaseClaimCalls = 0;

mock.module("./trigger-state.js", () => ({
  releaseProactiveArtifactClaim: () => {
    releaseClaimCalls++;
  },
}));

// Trust context mock
mock.module("../daemon/trust-context.js", () => ({
  INTERNAL_GUARDIAN_TRUST_CONTEXT: {
    sourceChannel: "vellum",
    trustClass: "guardian",
  },
}));

// Logger mock
let logWarnCalls: Array<{ args: unknown[] }> = [];

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: (...args: unknown[]) => {
      logWarnCalls.push({ args });
    },
    error: () => {},
    debug: () => {},
  }),
}));

// uuid mock — deterministic IDs for testing
let uuidCounter = 0;
mock.module("uuid", () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
}));

// ── Import SUT after mocks ─────────────────────────────────────────────

const { runProactiveArtifactJob } = await import("./job.js");
const { injectAuxAssistantMessage } = await import("./aux-message-injector.js");
const {
  buildMessageCopyPrompt,
  ensureMessageMentionsLibraryLocation,
  parseMessageCopy,
} = await import("./message-copy.js");

// ── Test helpers ────────────────────────────────────────────────────────

let broadcastCalls: Array<Record<string, unknown>> = [];
const mockBroadcast: any = (msg: Record<string, unknown>) => {
  broadcastCalls.push(msg);
};

const defaultTranscript = [
  { role: "user", content: "Hello there" },
  { role: "assistant", content: "Hi! How can I help?" },
  { role: "user", content: "I need a budget tracker" },
  { role: "assistant", content: "I can help with that." },
  { role: "user", content: "I spend about $3000 per month" },
  { role: "assistant", content: "Got it, that is useful context." },
  { role: "user", content: "Yes, let us track groceries and rent" },
  {
    role: "assistant",
    content: "Great, I will remember those categories.",
  },
];

const decisionYesApp = `SHOULD_BUILD: yes
ARTIFACT_TYPE: app
ARTIFACT_TITLE: Budget Tracker
ARTIFACT_DESCRIPTION: A budget tracking app for monthly expenses around $3000, focusing on groceries and rent.`;

const decisionYesDocument = `SHOULD_BUILD: yes
ARTIFACT_TYPE: document
ARTIFACT_TITLE: Monthly Budget Guide
ARTIFACT_DESCRIPTION: A structured guide for tracking monthly expenses with categories for groceries and rent.`;

const decisionNo = `SHOULD_BUILD: no
SKIP_REASON: Not enough context to build something specific.`;

function resetState() {
  decisionProviderAvailable = true;
  buildProviderAvailable = true;
  decisionResponse = "";
  buildResponse = "";
  copyResponse = "";
  providerSendCalls = [];
  rawAllRows = [];
  bootstrapCalls = [];
  processMessageCalls = [];
  processMessageShouldThrow = false;
  mockApps = [];
  addAppConvCalls = [];
  saveDocumentCalls = [];
  saveDocumentResult = { success: true, surfaceId: "doc-123" };
  addDocConvCalls = [];
  releaseClaimCalls = 0;
  addMessageCalls = [];
  emitSignalCalls = [];
  broadcastCalls = [];
  mockConversations = new Map();
  logWarnCalls = [];
  uuidCounter = 0;
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

describe("runProactiveArtifactJob", () => {
  describe("Phase 1 — Decision", () => {
    test("shouldBuild:false → releases claim, no Phase 2", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionNo;

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      expect(releaseClaimCalls).toBe(1);
      expect(bootstrapCalls).toHaveLength(0);
      expect(processMessageCalls).toHaveLength(0);
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
      expect(broadcastCalls).toHaveLength(0);
    });

    test("null (malformed) → releases claim, silent exit", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = "THIS IS GARBAGE OUTPUT";

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      expect(releaseClaimCalls).toBe(1);
      expect(bootstrapCalls).toHaveLength(0);
      expect(processMessageCalls).toHaveLength(0);
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
    });

    test("provider unavailable → releases claim, silent return", async () => {
      rawAllRows = defaultTranscript;
      decisionProviderAvailable = false;

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      expect(releaseClaimCalls).toBe(1);
      expect(providerSendCalls).toHaveLength(0);
      expect(bootstrapCalls).toHaveLength(0);
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
    });
  });

  describe("Phase 2 — Build", () => {
    test("Phase 2 failure → releases claim, no message, no notification", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesApp;
      processMessageShouldThrow = true;

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      // processMessage was called (the build attempt happened)
      expect(processMessageCalls).toHaveLength(1);
      // But no message injection or notification
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
      expect(broadcastCalls).toHaveLength(0);
      // Claim released so next turn can retry
      expect(releaseClaimCalls).toBe(1);
    });

    test("successful app: Phase 1 → Phase 2 → app store query → message copy → inject → notify", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesApp;
      copyResponse = "MESSAGE: I built a budget tracker for you!";

      const buildStartedAt = Date.now();
      mockApps = [
        {
          id: "app-123",
          name: "Budget Tracker",
          createdAt: buildStartedAt + 100,
          updatedAt: buildStartedAt + 100,
        },
      ];

      // Set up an idle conversation so injection works fully
      const convMessages: unknown[] = [];
      mockConversations.set("conv-1", {
        processing: false,
        messages: convMessages,
        getMessages: () => convMessages,
      });

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      // Phase 1: decision provider called
      expect(
        providerSendCalls.some(
          (c) => c.callSite === "proactiveArtifactDecision",
        ),
      ).toBe(true);

      // Phase 2: processMessage called with correct options
      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].prompt).toContain("Budget Tracker");
      expect(processMessageCalls[0].prompt).toContain("auto_open: false");
      const pmOpts = processMessageCalls[0].options as Record<string, unknown>;
      expect(pmOpts.callSite).toBe("proactiveArtifactBuild");
      expect(pmOpts.trustContext).toEqual({
        sourceChannel: "vellum",
        trustClass: "guardian",
      });

      // Bootstrap conversation created for app build
      expect(bootstrapCalls).toHaveLength(1);
      expect(bootstrapCalls[0].conversationType).toBe("background");
      expect(bootstrapCalls[0].source).toBe("proactive_artifact");

      // App associated with user's conversation for existing artifact linkage
      expect(addAppConvCalls).toHaveLength(1);
      expect(addAppConvCalls[0].appId).toBe("app-123");
      expect(addAppConvCalls[0].conversationId).toBe("conv-1");

      expect(broadcastCalls).toContainEqual({
        type: "app_files_changed",
        appId: "app-123",
      });

      // Message injection: addMessage called with skipIndexing
      expect(addMessageCalls).toHaveLength(1);
      expect(addMessageCalls[0].opts).toEqual({ skipIndexing: true });
      expect(addMessageCalls[0].conversationId).toBe("conv-1");
      const injectedAppContent = JSON.parse(addMessageCalls[0].content);
      expect(injectedAppContent[0].text).toContain("Library");
      expect(injectedAppContent[0].text).not.toContain("Assets");

      // Notification emitted
      expect(emitSignalCalls).toHaveLength(1);
      expect(emitSignalCalls[0].sourceEventName).toBe("activity.complete");
      expect(emitSignalCalls[0].sourceChannel).toBe("vellum");
      expect(emitSignalCalls[0].dedupeKey).toBe("proactive-artifact");
      const hints = emitSignalCalls[0].attentionHints as Record<
        string,
        unknown
      >;
      expect(hints.visibleInSourceNow).toBe(false);
      expect(hints.isAsyncBackground).toBe(true);
      expect(hints.requiresAction).toBe(false);
      // No conversationAffinityHint
      expect(emitSignalCalls[0].conversationAffinityHint).toBeUndefined();

      // Claim NOT released on success — guard stays permanent
      expect(releaseClaimCalls).toBe(0);
    });

    test("successful document: Phase 1 → content gen → saveDocument → message copy → inject → notify", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesDocument;
      buildResponse =
        "# Monthly Budget Guide\n\nTrack groceries and rent expenses.";
      copyResponse =
        "MESSAGE: I created a monthly budget guide tailored to your needs.";

      mockConversations.set("conv-1", {
        processing: false,
        messages: [],
        getMessages: () => [],
      });

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      // Document saved via saveDocument (not raw file writes)
      expect(saveDocumentCalls).toHaveLength(1);
      expect(saveDocumentCalls[0].title).toBe("Monthly Budget Guide");
      expect(saveDocumentCalls[0].conversationId).toBe("conv-1");
      expect(saveDocumentCalls[0].content).toContain("Monthly Budget Guide");
      expect(
        (saveDocumentCalls[0].surfaceId as string).startsWith("doc-"),
      ).toBe(true);
      expect((saveDocumentCalls[0].wordCount as number) > 0).toBe(true);

      // No bootstrapConversation or processMessage for document path
      expect(bootstrapCalls).toHaveLength(0);
      expect(processMessageCalls).toHaveLength(0);

      // Message injection and notification
      expect(addMessageCalls).toHaveLength(1);
      const injectedDocumentContent = JSON.parse(addMessageCalls[0].content);
      expect(injectedDocumentContent[0].text).toContain("Library");
      expect(injectedDocumentContent[0].text).not.toContain("Assets");
      expect(emitSignalCalls).toHaveLength(1);

      // Claim NOT released on success
      expect(releaseClaimCalls).toBe(0);
    });

    test("app build - no matching app found → releases claim for retry", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesApp;
      mockApps = []; // no apps in store

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      expect(processMessageCalls).toHaveLength(1);
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
      expect(releaseClaimCalls).toBe(1);
    });

    test("app decision with foreground app tool suppresses background build permanently", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesApp;

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        suppressAppBuild: true,
        broadcastMessage: mockBroadcast,
      });

      expect(bootstrapCalls).toHaveLength(0);
      expect(processMessageCalls).toHaveLength(0);
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
      expect(releaseClaimCalls).toBe(0);
    });

    test("app decision with recent app activity in source conversation suppresses background build permanently", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesApp;
      mockApps = [
        {
          id: "app-main",
          name: "Budget Tracker",
          createdAt: 1200,
          updatedAt: 1300,
          conversationIds: ["conv-1"],
        },
      ];

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      expect(bootstrapCalls).toHaveLength(0);
      expect(processMessageCalls).toHaveLength(0);
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
      expect(releaseClaimCalls).toBe(0);
    });

    test("document build - build provider unavailable → releases claim for retry", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesDocument;
      buildProviderAvailable = false;

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      // No message, no notification
      expect(addMessageCalls).toHaveLength(0);
      expect(emitSignalCalls).toHaveLength(0);
      expect(releaseClaimCalls).toBe(1);
    });
  });

  describe("Message copy", () => {
    test("uses fallback message when copy provider unavailable", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionYesApp;
      // Build provider is unavailable for copy step, but we need it for
      // the copy call. Since the same callSite is used, we'll test the
      // fallback by making the copy return unparseable output.
      buildProviderAvailable = true;
      copyResponse = "INVALID OUTPUT WITHOUT MESSAGE PREFIX";

      const buildTime = Date.now();
      mockApps = [
        { id: "app-456", name: "Budget Tracker", createdAt: buildTime + 50 },
      ];

      mockConversations.set("conv-1", {
        processing: false,
        messages: [],
        getMessages: () => [],
      });

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      // Verify fallback message was used
      expect(addMessageCalls).toHaveLength(1);
      const content = JSON.parse(addMessageCalls[0].content);
      expect(content[0].text).toContain("I made an app for you");
      expect(content[0].text).toContain("Budget Tracker");
      expect(content[0].text).toContain("Library");
      expect(content[0].text).not.toContain("Assets");
    });
  });

  describe("Transcript collection", () => {
    test("dual-condition transcript query uses userMessageCutoff and assistantMessageId", async () => {
      rawAllRows = defaultTranscript;
      decisionResponse = decisionNo;

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 5000,
        assistantMessageId: "asst-msg-99",
        broadcastMessage: mockBroadcast,
      });

      // The rawAll mock captures all calls; verify the decision was called
      // (proving transcript was collected and passed to decision)
      expect(
        providerSendCalls.some(
          (c) => c.callSite === "proactiveArtifactDecision",
        ),
      ).toBe(true);
    });

    test("empty transcript → early return", async () => {
      rawAllRows = [];

      await runProactiveArtifactJob({
        conversationId: "conv-1",
        userMessageCutoff: 1000,
        assistantMessageId: "msg-4",
        broadcastMessage: mockBroadcast,
      });

      expect(releaseClaimCalls).toBe(1);
      expect(providerSendCalls).toHaveLength(0);
      expect(addMessageCalls).toHaveLength(0);
    });
  });
});

describe("injectAuxAssistantMessage", () => {
  test("idle conversation: persists with skipIndexing, pushes to getMessages(), broadcasts delta + complete(aux) + list_invalidated", async () => {
    const messages: unknown[] = [];
    mockConversations.set("conv-inject-1", {
      processing: false,
      messages,
      getMessages: () => messages,
    });

    await injectAuxAssistantMessage({
      conversationId: "conv-inject-1",
      text: "Here is your artifact!",
      broadcastMessage: mockBroadcast,
    });

    // Persisted with skipIndexing
    expect(addMessageCalls).toHaveLength(1);
    expect(addMessageCalls[0].conversationId).toBe("conv-inject-1");
    expect(addMessageCalls[0].role).toBe("assistant");
    expect(addMessageCalls[0].opts).toEqual({ skipIndexing: true });

    // Pushed to in-memory messages
    expect(messages).toHaveLength(1);

    // Broadcasts: delta, complete(aux), list_invalidated
    const deltaMsg = broadcastCalls.find(
      (c) => c.type === "assistant_text_delta",
    );
    expect(deltaMsg).toBeDefined();
    expect(deltaMsg!.text).toBe("Here is your artifact!");
    expect(deltaMsg!.conversationId).toBe("conv-inject-1");

    const completeMsg = broadcastCalls.find(
      (c) => c.type === "message_complete",
    );
    expect(completeMsg).toBeDefined();
    expect(completeMsg!.source).toBe("aux");
    expect(completeMsg!.messageId).toBeDefined();

    const listMsg = broadcastCalls.find(
      (c) => c.type === "conversation_list_invalidated",
    );
    expect(listMsg).toBeDefined();
    expect(listMsg!.reason).toBe("reordered");
  });

  test("processing → idle: waits for processing to become false before persisting", async () => {
    const messages: unknown[] = [];
    let processingFlag = true;
    const conv: MockConversation = {
      get processing() {
        return processingFlag;
      },
      set processing(v: boolean) {
        processingFlag = v;
      },
      messages,
      getMessages: () => messages,
    };
    mockConversations.set("conv-inject-2", conv);

    // Simulate processing becoming idle after a short delay
    setTimeout(() => {
      processingFlag = false;
    }, 100);

    await injectAuxAssistantMessage({
      conversationId: "conv-inject-2",
      text: "Deferred message",
      broadcastMessage: mockBroadcast,
    });

    // Should have waited and then injected
    expect(addMessageCalls).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(broadcastCalls.some((c) => c.type === "assistant_text_delta")).toBe(
      true,
    );
  });

  test("processing → timeout: injects anyway with warning after poll timeout", async () => {
    const messages: unknown[] = [];
    // Conversation stays processing permanently — never becomes idle
    const conv: MockConversation = {
      processing: true,
      messages,
      getMessages: () => messages,
    };
    mockConversations.set("conv-inject-3", conv);

    // Mock Date.now() to simulate time past the 60s timeout.
    // First call sets `start`, second call must exceed IDLE_TIMEOUT_MS (60_000).
    const realDateNow = Date.now;
    let dateNowCallCount = 0;
    const baseTime = 1_000_000;
    Date.now = () => {
      dateNowCallCount++;
      // First call: start = baseTime
      // Second call onward: past the timeout
      if (dateNowCallCount <= 1) return baseTime;
      return baseTime + 60_001;
    };

    try {
      await injectAuxAssistantMessage({
        conversationId: "conv-inject-3",
        text: "Timeout message",
        broadcastMessage: mockBroadcast,
      });
    } finally {
      Date.now = realDateNow;
    }

    // Message was still persisted despite timeout
    expect(addMessageCalls).toHaveLength(1);
    expect(addMessageCalls[0].conversationId).toBe("conv-inject-3");

    // Warning log was emitted about the timeout
    expect(logWarnCalls.length).toBeGreaterThanOrEqual(1);
    const warnMsg = logWarnCalls.find((c) =>
      c.args.some(
        (arg) => typeof arg === "string" && arg.includes("Timed out"),
      ),
    );
    expect(warnMsg).toBeDefined();

    // Since conversation is still processing, no delta/complete broadcasts
    expect(
      broadcastCalls.filter((c) => c.type === "assistant_text_delta"),
    ).toHaveLength(0);
    expect(
      broadcastCalls.filter((c) => c.type === "message_complete"),
    ).toHaveLength(0);

    // But list_invalidated IS sent (always sent regardless of processing state)
    expect(
      broadcastCalls.filter((c) => c.type === "conversation_list_invalidated"),
    ).toHaveLength(1);
  });

  test("inactive/unloaded conversation: persists + list_invalidated only", async () => {
    // No conversation in the store
    await injectAuxAssistantMessage({
      conversationId: "conv-inject-4",
      text: "Offline message",
      broadcastMessage: mockBroadcast,
    });

    // Message persisted
    expect(addMessageCalls).toHaveLength(1);
    expect(addMessageCalls[0].conversationId).toBe("conv-inject-4");

    // No delta or complete (conversation not loaded)
    expect(
      broadcastCalls.filter((c) => c.type === "assistant_text_delta"),
    ).toHaveLength(0);
    expect(
      broadcastCalls.filter((c) => c.type === "message_complete"),
    ).toHaveLength(0);

    // But list_invalidated IS sent
    expect(
      broadcastCalls.filter((c) => c.type === "conversation_list_invalidated"),
    ).toHaveLength(1);
  });
});

describe("message-copy", () => {
  test("buildMessageCopyPrompt includes all parameters", () => {
    const prompt = buildMessageCopyPrompt({
      artifactType: "app",
      artifactTitle: "Budget Tracker",
      artifactId: "app-123",
      transcript: "[User]: I need a budget tool",
    });

    expect(prompt).toContain("app");
    expect(prompt).toContain("Budget Tracker");
    expect(prompt).toContain("app-123");
    expect(prompt).toContain("I need a budget tool");
    expect(prompt).toContain("Library");
    expect(prompt).not.toContain("Assets pill");
    expect(prompt).toContain("MESSAGE:");
  });

  test("parseMessageCopy extracts MESSAGE value", () => {
    expect(parseMessageCopy("MESSAGE: Hello there!")).toBe("Hello there!");
    expect(
      parseMessageCopy("MESSAGE: I built something special for you."),
    ).toBe("I built something special for you.");
  });

  test("parseMessageCopy returns null for missing MESSAGE", () => {
    expect(parseMessageCopy("Some random text")).toBeNull();
    expect(parseMessageCopy("")).toBeNull();
  });

  test("parseMessageCopy returns null for empty MESSAGE", () => {
    expect(parseMessageCopy("MESSAGE:   ")).toBeNull();
  });

  test("ensureMessageMentionsLibraryLocation appends missing location", () => {
    const message = ensureMessageMentionsLibraryLocation(
      "I built a budget tracker for your rent and groceries.",
      "app",
    );
    expect(message).toContain("Library");
    expect(message).not.toContain("Assets");
  });

  test("ensureMessageMentionsLibraryLocation normalizes terminal punctuation once", () => {
    const message = ensureMessageMentionsLibraryLocation(
      "I built a budget tracker for you!",
      "app",
    );
    expect(message).toBe(
      "I built a budget tracker for you. You can find the app in Library.",
    );
  });

  test("ensureMessageMentionsLibraryLocation replaces artifact panel wording", () => {
    const message = ensureMessageMentionsLibraryLocation(
      "You'll find it in the artifact panel.",
      "document",
    );
    expect(message).toContain("Library");
    expect(message).not.toContain("Assets");
    expect(message).not.toContain("artifact panel");
  });
});

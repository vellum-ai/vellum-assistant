import type * as net from "node:net";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import * as pendingInteractions from "../runtime/pending-interactions.js";

interface MockMemoryPolicy {
  scopeId: string;
  includeDefaultFallback: boolean;
  strictSideEffects: boolean;
}

const MOCK_DEFAULT_MEMORY_POLICY: MockMemoryPolicy = {
  scopeId: "default",
  includeDefaultFallback: false,
  strictSideEffects: false,
};

const conversation = {
  id: "conv-1",
  title: "Test Conversation",
  updatedAt: Date.now(),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCost: 0,
  threadType: "standard" as string,
  memoryScopeId: "default" as string,
};

let lastCreatedWorkingDir: string | undefined;
let lastCreatedMemoryPolicy: MockMemoryPolicy | undefined;
let lastCreateConversationArgs: unknown;

// Module-level test hooks checked by MockSession.runAgentLoop. Using module
// variables instead of class fields avoids the shadowing issue where class
// field declarations create own-properties that mask prototype assignments.
let mockConfirmationToEmitDuringLoop: Record<string, unknown> | undefined;
let mockMidLoopCallback: ((session: MockSession) => void) | undefined;
let lastCanonicalGuardianCreateParams: Record<string, unknown> | undefined;

class MockSession {
  public readonly conversationId: string;
  public memoryPolicy: MockMemoryPolicy;
  public updateClientCalls = 0;
  public ensureActorScopedHistoryCalls = 0;
  public lastUpdateClientHasNoClient: boolean | undefined;
  public lastUpdateClientSender:
    | ((msg: Record<string, unknown>) => void)
    | undefined;
  public lastRunAgentLoopOptions:
    | { skipPreMessageRollback?: boolean; isInteractive?: boolean }
    | undefined;
  public updateClientHistory: Array<{ hasNoClient: boolean }> = [];
  private stale = false;
  private processing = false;
  public trustContext: Record<string, unknown> | null = null;
  private _currentSender: ((msg: Record<string, unknown>) => void) | undefined;

  constructor(
    conversationId: string,
    _provider?: unknown,
    _systemPrompt?: string,
    _maxResponseTokens?: number,
    _sendToClient?: unknown,
    workingDir?: string,
    _broadcastToAllClients?: unknown,
    memoryPolicy?: MockMemoryPolicy,
  ) {
    this.conversationId = conversationId;
    lastCreatedWorkingDir = workingDir;
    this.memoryPolicy = memoryPolicy ?? MOCK_DEFAULT_MEMORY_POLICY;
    lastCreatedMemoryPolicy = this.memoryPolicy;
  }

  async loadFromDb(): Promise<void> {}

  async ensureActorScopedHistory(): Promise<void> {
    this.ensureActorScopedHistoryCalls += 1;
  }

  updateClient(
    sender?: (msg: Record<string, unknown>) => void,
    hasNoClient = false,
  ): void {
    this.updateClientCalls += 1;
    this.lastUpdateClientSender = sender;
    this.lastUpdateClientHasNoClient = hasNoClient;
    this.updateClientHistory.push({ hasNoClient });
    this._currentSender = sender;
  }

  getCurrentSender(): ((msg: Record<string, unknown>) => void) | undefined {
    return this._currentSender;
  }

  setSandboxOverride(): void {}

  isProcessing(): boolean {
    return this.processing;
  }

  isStale(): boolean {
    return this.stale;
  }

  markStale(): void {
    this.stale = true;
  }

  abort(): void {}

  dispose(): void {}

  hasEscalationHandler(): boolean {
    return true;
  }

  setEscalationHandler(): void {}

  handleConfirmationResponse(): void {}

  async processMessage(): Promise<void> {}

  setAssistantId(): void {}

  setTrustContext(ctx: Record<string, unknown> | null): void {
    this.trustContext = ctx;
  }

  setAuthContext(): void {}

  setChannelCapabilities(): void {}

  setCommandIntent(): void {}

  setTurnChannelContext(): void {}

  getTurnChannelContext(): null {
    return null;
  }

  setTurnInterfaceContext(): void {}

  getTurnInterfaceContext(): null {
    return null;
  }

  persistUserMessage(): string {
    this.processing = true;
    return "msg-1";
  }

  async runAgentLoop(
    _content: string,
    _messageId: string,
    onEvent: (msg: Record<string, unknown>) => void,
    options?: { skipPreMessageRollback?: boolean; isInteractive?: boolean },
  ): Promise<void> {
    this.lastRunAgentLoopOptions = options;
    if (mockConfirmationToEmitDuringLoop) {
      onEvent(mockConfirmationToEmitDuringLoop);
    }
    if (mockMidLoopCallback) {
      mockMidLoopCallback(this);
    }
    this.processing = false;
  }

  setPreactivatedSkillIds(): void {}

  getMessages(): Array<Record<string, unknown>> {
    return [];
  }

  undo(): number {
    return 1;
  }
}

// Mock child_process to prevent getScreenDimensions() from running osascript on Linux CI
// where AppKit/NSScreen is not available and the execSync call would fail.
mock.module("node:child_process", () => ({
  execSync: () => "1920x1080",
  execFileSync: () => "",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getSocketPath: () => "/tmp/test.sock",
  getDataDir: () => "/tmp",
  getSandboxWorkingDir: () => "/tmp/workspace",
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  getFailoverProvider: () => ({ name: "mock-provider" }),
  initializeProviders: () => {},
}));

mock.module("../providers/ratelimit.js", () => ({
  RateLimitProvider: class {
    constructor(..._args: unknown[]) {}
  },
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "mock-provider",
    providerOrder: ["mock-provider"],
    maxTokens: 4096,
    thinking: false,
    contextWindow: {
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: "mock-model",
      maxSummaryTokens: 512,
    },
    rateLimit: {
      maxRequestsPerMinute: 0,
      maxTokensPerSession: 0,
    },
    secretDetection: {
      enabled: false,
    },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../memory/external-conversation-store.js", () => ({
  getBindingsForConversations: () => new Map(),
}));

mock.module("../memory/conversation-attention-store.js", () => ({
  getAttentionStateByConversationIds: () => new Map(),
  recordAttentionSignal: () => {},
  recordConversationSeenSignal: () => {},
  markConversationUnread: () => {},
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  generateCanonicalRequestCode: () => "mock-code-0000",
  createCanonicalGuardianRequest: (params: Record<string, unknown>) => {
    lastCanonicalGuardianCreateParams = params;
    return { requestCode: "mock-code-0000", status: "pending" };
  },
  submitCanonicalRequest: () => ({
    requestCode: "mock-code-0000",
    status: "pending",
  }),
  getCanonicalRequest: () => null,
  resolveCanonicalRequest: () => false,
  listPendingCanonicalRequests: () => [],
}));

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  addMessage: () => ({ id: "mock-msg-id" }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  createConversation: (
    titleOrOpts?: string | { title?: string; threadType?: string },
  ) => {
    lastCreateConversationArgs = titleOrOpts;
    // Derive threadType and memoryScopeId from input, mirroring real implementation
    const opts =
      typeof titleOrOpts === "string"
        ? { title: titleOrOpts }
        : (titleOrOpts ?? {});
    const threadType = opts.threadType ?? "standard";
    conversation.threadType = threadType;
    conversation.memoryScopeId =
      threadType === "private" ? `private:${conversation.id}` : "default";
    return conversation;
  },
  getConversation: (id: string) =>
    id === conversation.id ? conversation : null,
  getConversationThreadType: (id: string) => {
    if (id === conversation.id)
      return conversation.threadType === "private" ? "private" : "standard";
    return "standard";
  },
  getConversationMemoryScopeId: (id: string) => {
    if (id === conversation.id) return conversation.memoryScopeId;
    return "default";
  },
  getMessages: () => [],
  getDisplayMetaForConversations: () => new Map(),
}));

mock.module("../memory/conversation-queries.js", () => ({
  getLatestConversation: () => conversation,
  listConversations: () => [conversation],
  countConversations: () => 1,
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: () => ({
    skipped: true,
    reason: "not_trusted_contact",
  }),
}));

mock.module("../daemon/session.js", () => ({
  Session: MockSession,
  DEFAULT_MEMORY_POLICY: MOCK_DEFAULT_MEMORY_POLICY,
}));

import { DaemonServer } from "../daemon/server.js";

type DaemonServerTestAccess = {
  sendInitialSession: (socket: net.Socket) => Promise<void>;
  dispatchMessage: (
    msg: { type: string; [key: string]: unknown },
    socket: net.Socket,
  ) => void;
  sessions: Map<string, MockSession>;
  socketToSession: Map<net.Socket, string>;
};

function asDaemonServerTestAccess(
  server: DaemonServer,
): DaemonServerTestAccess {
  return server as unknown as DaemonServerTestAccess;
}

function createFakeSocket() {
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  } as unknown as net.Socket;

  return { socket, writes };
}

function decodeMessages(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("DaemonServer initial session hydration", () => {
  beforeEach(() => {
    conversation.updatedAt = Date.now();
    conversation.threadType = "standard";
    conversation.memoryScopeId = "default";
    lastCreatedWorkingDir = undefined;
    lastCreatedMemoryPolicy = undefined;
    lastCreateConversationArgs = undefined;
    lastCanonicalGuardianCreateParams = undefined;
    mockConfirmationToEmitDuringLoop = undefined;
    mockMidLoopCallback = undefined;
    pendingInteractions.clear();
  });

  test("hydrates latest session before session_info so undo works after reconnect", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    await internal.sendInitialSession(socket);
    internal.dispatchMessage(
      { type: "undo", sessionId: conversation.id },
      socket,
    );

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === "session_info");
    const undoComplete = messages.find((msg) => msg.type === "undo_complete");
    const error = messages.find((msg) => msg.type === "error");

    expect(sessionInfo).toBeDefined();
    expect(undoComplete).toBeDefined();
    expect(error).toBeUndefined();
  });

  test("does not rebind existing session client during initial handshake", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const existingSession = new MockSession(conversation.id);
    internal.sessions.set(conversation.id, existingSession);

    const { socket } = createFakeSocket();
    await internal.sendInitialSession(socket);

    expect(existingSession.updateClientCalls).toBe(0);
    expect(internal.socketToSession.size).toBe(0);
  });

  test("creates sessions with sandbox working dir by default", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    expect(lastCreatedWorkingDir).toBe("/tmp/workspace");
  });

  test("sendInitialSession includes threadType in session_info", async () => {
    conversation.threadType = "private";
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === "session_info");
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe("private");
  });

  test("sendInitialSession includes standard threadType by default", async () => {
    conversation.threadType = "standard";
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === "session_info");
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe("standard");
  });

  test("session_switch includes threadType in session_info", async () => {
    conversation.threadType = "private";
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    // Hydrate the session first so switch has something to find
    await internal.sendInitialSession(socket);
    writes.length = 0;

    internal.dispatchMessage(
      { type: "session_switch", sessionId: conversation.id },
      socket,
    );
    // Allow async handler to complete
    await new Promise((r) => setTimeout(r, 50));

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === "session_info");
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe("private");
  });

  test("session_create includes threadType in session_info response", async () => {
    // conversation.threadType starts as 'standard' from beforeEach — the mock
    // createConversation must derive 'private' from the IPC request input.
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    internal.dispatchMessage(
      {
        type: "session_create",
        title: "Thread-type test",
        threadType: "private",
      },
      socket,
    );
    // Allow async handler to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify createConversation was called with the threadType from the request
    expect(lastCreateConversationArgs).toEqual({
      title: "Thread-type test",
      threadType: "private",
    });

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === "session_info");
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe("private");
  });

  test("session_list includes threadType on each session row", async () => {
    conversation.threadType = "private";
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    internal.dispatchMessage({ type: "session_list" }, socket);

    const messages = decodeMessages(writes);
    const listResponse = messages.find(
      (msg) => msg.type === "session_list_response",
    );
    expect(listResponse).toBeDefined();

    const sessions = listResponse!.sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.threadType).toBe("private");
    }
  });

  test("session for private conversation derives strict memory policy", async () => {
    conversation.threadType = "private";
    conversation.memoryScopeId = "private:conv-1";
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.memoryPolicy).toEqual({
      scopeId: "private:conv-1",
      includeDefaultFallback: true,
      strictSideEffects: true,
    });
  });

  test("session for standard conversation uses default memory policy", async () => {
    conversation.threadType = "standard";
    conversation.memoryScopeId = "default";
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.memoryPolicy).toEqual(MOCK_DEFAULT_MEMORY_POLICY);
  });

  test("session_switch to private conversation derives correct policy on fresh session", async () => {
    // Start with standard conversation
    conversation.threadType = "standard";
    conversation.memoryScopeId = "default";
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    // Now switch the conversation metadata to private before the switch
    conversation.threadType = "private";
    conversation.memoryScopeId = "private:conv-1";

    // Evict the existing session so the switch recreates it
    const existingSession = internal.sessions.get(conversation.id);
    if (existingSession) {
      existingSession.markStale();
    }

    internal.dispatchMessage(
      { type: "session_switch", sessionId: conversation.id },
      socket,
    );
    await new Promise((r) => setTimeout(r, 50));

    // The recreated session should have the private policy
    expect(lastCreatedMemoryPolicy).toEqual({
      scopeId: "private:conv-1",
      includeDefaultFallback: true,
      strictSideEffects: true,
    });
  });

  test("session_create normalizes unrecognized threadType to standard", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    internal.dispatchMessage(
      {
        type: "session_create",
        title: "Bad threadType",
        threadType: "bogus" as unknown,
      },
      socket,
    );
    await new Promise((r) => setTimeout(r, 50));

    // Should normalize to 'standard'
    expect(lastCreateConversationArgs).toEqual({
      title: "Bad threadType",
      threadType: "standard",
    });

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === "session_info");
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe("standard");
  });

  test("session_create defaults missing threadType to standard", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    internal.dispatchMessage(
      {
        type: "session_create",
        title: "No threadType",
      },
      socket,
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(lastCreateConversationArgs).toEqual({
      title: "No threadType",
      threadType: "standard",
    });

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === "session_info");
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe("standard");
  });

  test("session_create with private threadType derives correct policy", async () => {
    // conversation starts as 'standard' from beforeEach — the mock
    // createConversation must derive private state from the IPC request.
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    internal.dispatchMessage(
      {
        type: "session_create",
        title: "Private Thread",
        threadType: "private",
      },
      socket,
    );
    await new Promise((r) => setTimeout(r, 50));

    // Verify createConversation received the threadType
    expect(lastCreateConversationArgs).toEqual({
      title: "Private Thread",
      threadType: "private",
    });

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.memoryPolicy).toEqual({
      scopeId: "private:conv-1",
      includeDefaultFallback: true,
      strictSideEffects: true,
    });
  });

  test("interactive HTTP processing marks no-socket sessions interactive and registers confirmation prompts", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);

    // Pre-configure the mock to emit a confirmation_request during runAgentLoop,
    // simulating a tool requesting approval while the session is interactive.
    mockConfirmationToEmitDuringLoop = {
      type: "confirmation_request",
      requestId: "req-interactive-1",
      toolName: "notify_desktop",
      input: { title: "Weather" },
      riskLevel: "high",
      allowlistOptions: [
        {
          label: "notify_desktop:*",
          description: "notify_desktop:*",
          pattern: "notify_desktop:*",
        },
      ],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
      persistentDecisionsAllowed: true,
    };

    await server.processMessage(
      conversation.id,
      "send me a notification",
      undefined,
      { isInteractive: true },
      "telegram",
      "telegram",
    );

    mockConfirmationToEmitDuringLoop = undefined;

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.lastRunAgentLoopOptions?.isInteractive).toBe(true);
    expect(session!.ensureActorScopedHistoryCalls).toBeGreaterThanOrEqual(1);

    // Verify the session was marked interactive during the loop, then restored.
    // updateClientHistory: [0] = initial no-socket creation (hasNoClient: true),
    //                      [1] = interactive override (hasNoClient: false),
    //                      [2] = reset after loop (hasNoClient: true)
    expect(session!.updateClientHistory.length).toBeGreaterThanOrEqual(3);
    expect(session!.updateClientHistory[1].hasNoClient).toBe(false);
    expect(session!.updateClientHistory[2].hasNoClient).toBe(true);

    // After the loop completes, the session is restored to no-client state.
    expect(session!.lastUpdateClientHasNoClient).toBe(true);

    // The pending interaction was registered during the loop.
    const interaction = pendingInteractions.get("req-interactive-1");
    expect(interaction).toBeDefined();
    expect(interaction?.kind).toBe("confirmation");
    expect(interaction?.conversationId).toBe(conversation.id);
  });

  test("confirmation_request canonical records include bound guardian identity context", async () => {
    const server = new DaemonServer();

    mockConfirmationToEmitDuringLoop = {
      type: "confirmation_request",
      requestId: "req-bound-1",
      toolName: "host_bash",
      input: { command: "ls" },
      riskLevel: "high",
      allowlistOptions: [
        {
          label: "host_bash:*",
          description: "host_bash:*",
          pattern: "host_bash:*",
        },
      ],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
      persistentDecisionsAllowed: true,
    };

    await server.processMessage(
      conversation.id,
      "run ls",
      undefined,
      {
        isInteractive: false,
        trustContext: {
          sourceChannel: "telegram",
          trustClass: "trusted_contact",
          guardianExternalUserId: "guardian-123",
          requesterExternalUserId: "trusted-456",
          requesterChatId: "chat-789",
        },
      },
      "telegram",
      "telegram",
    );

    expect(lastCanonicalGuardianCreateParams).toBeDefined();
    expect(lastCanonicalGuardianCreateParams).toMatchObject({
      id: "req-bound-1",
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: conversation.id,
      guardianExternalUserId: "guardian-123",
      requesterExternalUserId: "trusted-456",
      requesterChatId: "chat-789",
      toolName: "host_bash",
      status: "pending",
      requestCode: "mock-code-0000",
    });
  });

  test("finally block does not overwrite IPC client that connected during interactive agent loop (processMessage)", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);

    const ipcSender = (_msg: Record<string, unknown>) => {};

    // Simulate a real IPC client connecting mid-loop by rebinding the session
    // sender during runAgentLoop execution.
    mockMidLoopCallback = (session) => {
      session.updateClient(ipcSender, false);
    };

    await server.processMessage(
      conversation.id,
      "hello",
      undefined,
      { isInteractive: true },
      "telegram",
      "telegram",
    );

    mockMidLoopCallback = undefined;

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();

    // The finally block should NOT have reset the sender because the session's
    // current sender was rebound to ipcSender mid-loop, which differs from the
    // onEvent callback originally set for the interactive path.
    expect(session!.getCurrentSender()).toBe(ipcSender);
    expect(session!.lastUpdateClientHasNoClient).toBe(false);
  });

  test("finally block does not overwrite IPC client that connected during interactive agent loop (persistAndProcessMessage)", async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);

    const ipcSender = (_msg: Record<string, unknown>) => {};

    // Simulate a real IPC client connecting mid-loop by rebinding the session
    // sender during runAgentLoop execution.
    mockMidLoopCallback = (session) => {
      session.updateClient(ipcSender, false);
    };

    const { messageId } = await server.persistAndProcessMessage(
      conversation.id,
      "hello",
      undefined,
      { isInteractive: true },
      "telegram",
      "telegram",
    );
    expect(messageId).toBe("msg-1");

    // persistAndProcessMessage fires the loop in the background; wait for it.
    await new Promise((r) => setTimeout(r, 50));

    mockMidLoopCallback = undefined;

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();

    // The finally block should NOT have reset the sender because the session's
    // current sender was rebound to ipcSender mid-loop.
    expect(session!.getCurrentSender()).toBe(ipcSender);
    expect(session!.lastUpdateClientHasNoClient).toBe(false);
  });
});

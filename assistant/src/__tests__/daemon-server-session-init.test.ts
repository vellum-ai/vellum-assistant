import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type * as net from 'node:net';

interface MockMemoryPolicy {
  scopeId: string;
  includeDefaultFallback: boolean;
  strictSideEffects: boolean;
}

const MOCK_DEFAULT_MEMORY_POLICY: MockMemoryPolicy = {
  scopeId: 'default',
  includeDefaultFallback: false,
  strictSideEffects: false,
};

const conversation = {
  id: 'conv-1',
  title: 'Test Conversation',
  updatedAt: Date.now(),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCost: 0,
  threadType: 'standard' as string,
  memoryScopeId: 'default' as string,
};

let lastCreatedWorkingDir: string | undefined;
let lastCreatedMemoryPolicy: MockMemoryPolicy | undefined;

class MockSession {
  public readonly conversationId: string;
  public memoryPolicy: MockMemoryPolicy;
  public updateClientCalls = 0;
  public setSandboxOverrideCalls = 0;
  private stale = false;
  private processing = false;

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

  updateClient(): void {
    this.updateClientCalls += 1;
  }

  setSandboxOverride(): void {
    this.setSandboxOverrideCalls += 1;
  }

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

  undo(): number {
    return 1;
  }
}

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getSocketPath: () => '/tmp/test.sock',
  getDataDir: () => '/tmp',
  getSandboxWorkingDir: () => '/tmp/workspace',
}));

mock.module('../providers/registry.js', () => ({
  getProvider: () => ({ name: 'mock-provider' }),
  getFailoverProvider: () => ({ name: 'mock-provider' }),
  initializeProviders: () => {},
}));

mock.module('../providers/ratelimit.js', () => ({
  RateLimitProvider: class {
    constructor(..._args: unknown[]) {}
  },
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    provider: 'mock-provider',
    providerOrder: ['mock-provider'],
    maxTokens: 4096,
    thinking: false,
    contextWindow: {
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: 'mock-model',
      maxSummaryTokens: 512,
    },
    rateLimit: {
      maxRequestsPerMinute: 0,
      maxTokensPerSession: 0,
    },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module('../config/system-prompt.js', () => ({
  buildSystemPrompt: () => 'system prompt',
}));

mock.module('../permissions/trust-store.js', () => ({
  clearCache: () => {},
}));

mock.module('../security/secret-allowlist.js', () => ({
  resetAllowlist: () => {},
}));

mock.module('../memory/conversation-store.js', () => ({
  getLatestConversation: () => conversation,
  createConversation: () => conversation,
  getConversation: (id: string) => (id === conversation.id ? conversation : null),
  getConversationThreadType: (id: string) => {
    if (id === conversation.id) return conversation.threadType === 'private' ? 'private' : 'standard';
    return 'standard';
  },
  getConversationMemoryScopeId: (id: string) => {
    if (id === conversation.id) return conversation.memoryScopeId;
    return 'default';
  },
  getMessages: () => [],
  listConversations: () => [conversation],
}));

mock.module('../daemon/session.js', () => ({
  Session: MockSession,
  DEFAULT_MEMORY_POLICY: MOCK_DEFAULT_MEMORY_POLICY,
}));

import { DaemonServer } from '../daemon/server.js';

type DaemonServerTestAccess = {
  sendInitialSession: (socket: net.Socket) => Promise<void>;
  dispatchMessage: (msg: { type: string; [key: string]: unknown }, socket: net.Socket) => void;
  sessions: Map<string, MockSession>;
  socketToSession: Map<net.Socket, string>;
};

function asDaemonServerTestAccess(server: DaemonServer): DaemonServerTestAccess {
  return server as unknown as DaemonServerTestAccess;
}

function createFakeSocket() {
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  } as unknown as net.Socket;

  return { socket, writes };
}

function decodeMessages(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('DaemonServer initial session hydration', () => {
  beforeEach(() => {
    conversation.updatedAt = Date.now();
    conversation.threadType = 'standard';
    conversation.memoryScopeId = 'default';
    lastCreatedWorkingDir = undefined;
    lastCreatedMemoryPolicy = undefined;
  });

  test('hydrates latest session before session_info so undo works after reconnect', async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    await internal.sendInitialSession(socket);
    internal.dispatchMessage({ type: 'undo', sessionId: conversation.id }, socket);

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === 'session_info');
    const undoComplete = messages.find((msg) => msg.type === 'undo_complete');
    const error = messages.find((msg) => msg.type === 'error');

    expect(sessionInfo).toBeDefined();
    expect(undoComplete).toBeDefined();
    expect(error).toBeUndefined();
  });

  test('does not rebind existing session client during initial handshake', async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const existingSession = new MockSession(conversation.id);
    internal.sessions.set(conversation.id, existingSession);

    const { socket } = createFakeSocket();
    await internal.sendInitialSession(socket);

    expect(existingSession.updateClientCalls).toBe(0);
    expect(internal.socketToSession.size).toBe(0);
  });

  test('creates sessions with sandbox working dir by default', async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    expect(lastCreatedWorkingDir).toBe('/tmp/workspace');
  });

  test('ignores deprecated sandbox_set runtime override messages', async () => {
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);
    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.setSandboxOverrideCalls).toBe(0);

    internal.dispatchMessage({ type: 'sandbox_set', enabled: false }, socket);

    expect(session!.setSandboxOverrideCalls).toBe(0);
  });

  test('sendInitialSession includes threadType in session_info', async () => {
    conversation.threadType = 'private';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === 'session_info');
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe('private');
  });

  test('sendInitialSession includes standard threadType by default', async () => {
    conversation.threadType = 'standard';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === 'session_info');
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe('standard');
  });

  test('session_switch includes threadType in session_info', async () => {
    conversation.threadType = 'private';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    // Hydrate the session first so switch has something to find
    await internal.sendInitialSession(socket);
    writes.length = 0;

    internal.dispatchMessage({ type: 'session_switch', sessionId: conversation.id }, socket);
    // Allow async handler to complete
    await new Promise((r) => setTimeout(r, 50));

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === 'session_info');
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe('private');
  });

  test('session_create includes threadType in session_info response', async () => {
    conversation.threadType = 'private';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    internal.dispatchMessage({
      type: 'session_create',
      title: 'Thread-type test',
      threadType: 'private',
    }, socket);
    // Allow async handler to complete
    await new Promise((r) => setTimeout(r, 50));

    const messages = decodeMessages(writes);
    const sessionInfo = messages.find((msg) => msg.type === 'session_info');
    expect(sessionInfo).toBeDefined();
    expect(sessionInfo!.threadType).toBe('private');
  });

  test('session_list includes threadType on each session row', async () => {
    conversation.threadType = 'private';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket, writes } = createFakeSocket();

    internal.dispatchMessage({ type: 'session_list' }, socket);

    const messages = decodeMessages(writes);
    const listResponse = messages.find((msg) => msg.type === 'session_list_response');
    expect(listResponse).toBeDefined();

    const sessions = listResponse!.sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.threadType).toBe('private');
    }
  });

  test('session for private conversation derives strict memory policy', async () => {
    conversation.threadType = 'private';
    conversation.memoryScopeId = 'private:conv-1';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.memoryPolicy).toEqual({
      scopeId: 'private:conv-1',
      includeDefaultFallback: true,
      strictSideEffects: true,
    });
  });

  test('session for standard conversation uses default memory policy', async () => {
    conversation.threadType = 'standard';
    conversation.memoryScopeId = 'default';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.memoryPolicy).toEqual(MOCK_DEFAULT_MEMORY_POLICY);
  });

  test('session_switch to private conversation derives correct policy on fresh session', async () => {
    // Start with standard conversation
    conversation.threadType = 'standard';
    conversation.memoryScopeId = 'default';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    await internal.sendInitialSession(socket);

    // Now switch the conversation metadata to private before the switch
    conversation.threadType = 'private';
    conversation.memoryScopeId = 'private:conv-1';

    // Evict the existing session so the switch recreates it
    const existingSession = internal.sessions.get(conversation.id);
    if (existingSession) {
      existingSession.markStale();
    }

    internal.dispatchMessage({ type: 'session_switch', sessionId: conversation.id }, socket);
    await new Promise((r) => setTimeout(r, 50));

    // The recreated session should have the private policy
    expect(lastCreatedMemoryPolicy).toEqual({
      scopeId: 'private:conv-1',
      includeDefaultFallback: true,
      strictSideEffects: true,
    });
  });

  test('session_create with private threadType derives correct policy', async () => {
    conversation.threadType = 'private';
    conversation.memoryScopeId = 'private:conv-1';
    const server = new DaemonServer();
    const internal = asDaemonServerTestAccess(server);
    const { socket } = createFakeSocket();

    internal.dispatchMessage({
      type: 'session_create',
      title: 'Private Thread',
      threadType: 'private',
    }, socket);
    await new Promise((r) => setTimeout(r, 50));

    const session = internal.sessions.get(conversation.id);
    expect(session).toBeDefined();
    expect(session!.memoryPolicy).toEqual({
      scopeId: 'private:conv-1',
      includeDefaultFallback: true,
      strictSideEffects: true,
    });
  });
});

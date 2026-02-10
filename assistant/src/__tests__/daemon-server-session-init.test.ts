import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type * as net from 'node:net';

const conversation = {
  id: 'conv-1',
  title: 'Test Conversation',
  updatedAt: Date.now(),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCost: 0,
};

class MockSession {
  public readonly conversationId: string;
  public updateClientCalls = 0;
  private stale = false;
  private processing = false;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  async loadFromDb(): Promise<void> {}

  updateClient(): void {
    this.updateClientCalls += 1;
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
}));

mock.module('../providers/registry.js', () => ({
  getProvider: () => ({ name: 'mock-provider' }),
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
    maxTokens: 4096,
    thinking: false,
    systemPrompt: {},
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
  getMessages: () => [],
  listConversations: () => [conversation],
}));

mock.module('../daemon/session.js', () => ({
  Session: MockSession,
}));

import { DaemonServer } from '../daemon/server.js';

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
  });

  test('hydrates latest session before session_info so undo works after reconnect', async () => {
    const server = new DaemonServer();
    const { socket, writes } = createFakeSocket();

    await (server as any).sendInitialSession(socket);
    (server as any).handleUndo(conversation.id, socket);

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
    const existingSession = new MockSession(conversation.id);
    (server as any).sessions.set(conversation.id, existingSession);

    const { socket } = createFakeSocket();
    await (server as any).sendInitialSession(socket);

    expect(existingSession.updateClientCalls).toBe(0);
    expect((server as any).socketToSession.size).toBe(0);
  });
});

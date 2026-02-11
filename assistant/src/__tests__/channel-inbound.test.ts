import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'channel-inbound-test-'));

// ── Mocks ────────────────────────────────────────────────────────────────────

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
  isDebug: () => false,
  truncateForLog: (v: string) => v,
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
    auditLog: { retentionDays: 0 },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  loadConfig: () => ({
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
    auditLog: { retentionDays: 0 },
  }),
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

mock.module('../tools/registry.js', () => ({
  getAllToolDefinitions: () => [],
  initializeTools: async () => {},
}));

// Mock Session to capture processMessage calls and simulate AI response
let processMessageCalls: Array<{ conversationId: string; content: string }> = [];
let mockAssistantResponse = 'Hello from the assistant!';

class MockSession {
  public readonly conversationId: string;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  async loadFromDb(): Promise<void> {}
  updateClient(): void {}
  setSandboxOverride(): void {}
  isProcessing(): boolean { return false; }
  isStale(): boolean { return false; }
  markStale(): void {}
  abort(): void {}
  handleConfirmationResponse(): void {}
  undo(): number { return 0; }

  async processMessage(
    content: string,
    _attachments: unknown[],
    onEvent: (msg: Record<string, unknown>) => void,
  ): Promise<void> {
    processMessageCalls.push({ conversationId: this.conversationId, content });

    // Simulate assistant text deltas
    onEvent({ type: 'assistant_text_delta', text: mockAssistantResponse });
    // Signal completion
    onEvent({ type: 'message_complete' });
  }
}

mock.module('../daemon/session.js', () => ({
  Session: MockSession,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { initializeDb, getDb } from '../memory/db.js';
import * as conversationStore from '../memory/conversation-store.js';
import { recordInbound } from '../memory/channel-delivery-store.js';
import { DaemonServer } from '../daemon/server.js';

// Initialize DB
initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('recordInbound', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM channel_inbound_events');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversation_keys');
    db.run('DELETE FROM conversations');
  });

  test('does not add a user message to the conversation', () => {
    const result = recordInbound(
      'assistant-1',
      'telegram',
      'chat-123',
      'msg-1',
    );

    expect(result.accepted).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.conversationId).toBeTruthy();

    // Verify no messages were added to the conversation
    const messages = conversationStore.getMessages(result.conversationId);
    expect(messages).toHaveLength(0);
  });

  test('returns duplicate for the same message', () => {
    const first = recordInbound('assistant-1', 'telegram', 'chat-123', 'msg-1');
    const second = recordInbound('assistant-1', 'telegram', 'chat-123', 'msg-1');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(second.conversationId).toBe(first.conversationId);
  });

  test('creates separate conversations for different chats', () => {
    const a = recordInbound('assistant-1', 'telegram', 'chat-111', 'msg-1');
    const b = recordInbound('assistant-1', 'telegram', 'chat-222', 'msg-1');

    expect(a.conversationId).not.toBe(b.conversationId);
  });
});

describe('DaemonServer.processMessage', () => {
  beforeEach(() => {
    processMessageCalls = [];
    mockAssistantResponse = 'Hello from the assistant!';

    const db = getDb();
    db.run('DELETE FROM channel_inbound_events');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversation_keys');
    db.run('DELETE FROM conversations');
  });

  test('calls processMessage and returns assistant text', async () => {
    // Create a conversation first
    const conv = conversationStore.createConversation('test channel');

    const server = new DaemonServer();
    const result = await server.processMessage(conv.id, 'What is 2+2?');

    expect(result).toBe('Hello from the assistant!');
    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].content).toBe('What is 2+2?');
    expect(processMessageCalls[0].conversationId).toBe(conv.id);
  });

  test('returns null when assistant produces no text', async () => {
    mockAssistantResponse = '';
    const conv = conversationStore.createConversation('test channel');

    const server = new DaemonServer();
    const result = await server.processMessage(conv.id, 'Hello');

    expect(result).toBeNull();
  });
});

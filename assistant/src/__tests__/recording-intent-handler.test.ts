/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import * as net from 'node:net';

// ─── Mocks (must be before any imports that depend on them) ─────────────────

const noop = () => {};
const noopLogger = {
  info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
  child: () => noopLogger,
};

mock.module('../util/logger.js', () => ({
  getLogger: () => noopLogger,
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    daemon: { standaloneRecording: true },
    provider: 'mock-provider',
    model: 'mock-model',
    permissions: { mode: 'legacy' },
    apiKeys: {},
    sandbox: { enabled: false },
    timeouts: { toolExecutionTimeoutSec: 30, permissionTimeoutSec: 5 },
    skills: { load: { extraDirs: [] } },
    secretDetection: { enabled: false, allowOneTimeSend: false },
    contextWindow: {
      enabled: true,
      maxInputTokens: 180000,
      targetInputTokens: 110000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 8,
      summaryMaxTokens: 1200,
      chunkTokens: 12000,
    },
  }),
  invalidateConfigCache: noop,
  loadConfig: noop,
  saveConfig: noop,
  loadRawConfig: () => ({}),
  saveRawConfig: noop,
  getNestedValue: () => undefined,
  setNestedValue: noop,
}));

// ── Mock identity-helpers ──────────────────────────────────────────────────

let mockAssistantName: string | null = null;

mock.module('../daemon/identity-helpers.js', () => ({
  getAssistantName: () => mockAssistantName,
}));

// ── Mock recording-intent — we control the resolver result ─────────────────

import type { RecordingIntentResult } from '../daemon/recording-intent.js';

let mockResolveResult: RecordingIntentResult = { kind: 'none' };

mock.module('../daemon/recording-intent.js', () => ({
  resolveRecordingIntent: () => mockResolveResult,
}));

// ── Mock recording handlers ────────────────────────────────────────────────

let recordingStartCalled = false;
let recordingStopCalled = false;

// ── Mock recording-executor — we control the execution result ──────────────

mock.module('../daemon/recording-executor.js', () => ({
  executeRecordingIntent: (intent: RecordingIntentResult, _context: any) => {
    if (intent.kind === 'none') return { handled: false };
    if (intent.kind === 'start_only') {
      recordingStartCalled = true;
      return { handled: true, responseText: 'Starting screen recording.' };
    }
    if (intent.kind === 'stop_only') {
      recordingStopCalled = true;
      return { handled: true, responseText: 'Stopping the recording.' };
    }
    if (intent.kind === 'start_with_remainder') {
      return { handled: false, remainderText: (intent as any).remainder, pendingStart: true };
    }
    if (intent.kind === 'stop_with_remainder') {
      return { handled: false, remainderText: (intent as any).remainder, pendingStop: true };
    }
    // Other intents fall through
    return { handled: false };
  },
}));

mock.module('../daemon/handlers/recording.js', () => ({
  handleRecordingStart: () => {
    recordingStartCalled = true;
    return 'mock-recording-id';
  },
  handleRecordingStop: () => {
    recordingStopCalled = true;
    return 'mock-recording-id';
  },
  recordingHandlers: {},
  __resetRecordingState: noop,
}));

// ── Mock conversation store ────────────────────────────────────────────────

mock.module('../memory/conversation-store.js', () => ({
  getMessages: () => [],
  addMessage: () => ({ id: 'msg-mock', role: 'assistant', content: '' }),
  createConversation: (title?: string) => ({ id: 'conv-mock', title: title ?? 'Untitled' }),
  getConversation: () => ({ id: 'conv-mock' }),
  updateConversationTitle: noop,
  clearAll: noop,
  listConversations: () => [],
  countConversations: () => 0,
  searchConversations: () => [],
  deleteConversation: noop,
}));

mock.module('../memory/conversation-title-service.js', () => ({
  GENERATING_TITLE: '(generating…)',
  queueGenerateConversationTitle: noop,
  UNTITLED_FALLBACK: 'Untitled',
}));

mock.module('../memory/attachments-store.js', () => ({
  getAttachmentsForMessage: () => [],
  uploadFileBackedAttachment: () => ({ id: 'att-mock' }),
  linkAttachmentToMessage: noop,
  setAttachmentThumbnail: noop,
}));

// ── Mock security ──────────────────────────────────────────────────────────

mock.module('../security/secret-ingress.js', () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

// ── Mock classifier (for task_submit fallthrough) ──────────────────────────

let classifierCalled = false;

mock.module('../daemon/classifier.js', () => ({
  classifyInteraction: async () => {
    classifierCalled = true;
    return 'text_qa';
  },
}));

// ── Mock slash commands ────────────────────────────────────────────────────

mock.module('../skills/slash-commands.js', () => ({
  parseSlashCandidate: () => ({ kind: 'none' }),
}));

// ── Mock computer-use handler ──────────────────────────────────────────────

mock.module('../daemon/handlers/computer-use.js', () => ({
  handleCuSessionCreate: noop,
}));

// ── Mock provider ──────────────────────────────────────────────────────────

mock.module('../providers/provider-send-message.js', () => ({
  getConfiguredProvider: () => null,
}));

// ── Mock external conversation store ───────────────────────────────────────

mock.module('../memory/external-conversation-store.js', () => ({
  getBindingsForConversations: () => new Map(),
}));

// ── Mock subagent manager ──────────────────────────────────────────────────

mock.module('../subagent/index.js', () => ({
  getSubagentManager: () => ({
    abortAllForParent: noop,
  }),
}));

// ── Mock IPC protocol helpers ──────────────────────────────────────────────

mock.module('../daemon/ipc-protocol.js', () => ({
  normalizeThreadType: (t: string) => t ?? 'primary',
}));

// ── Mock session error helpers ─────────────────────────────────────────────

mock.module('../daemon/session-error.js', () => ({
  classifySessionError: () => ({ code: 'UNKNOWN', userMessage: 'error', retryable: false }),
  buildSessionErrorMessage: () => ({ type: 'error', message: 'error' }),
}));

// ── Mock video thumbnail ───────────────────────────────────────────────────

mock.module('../daemon/video-thumbnail.js', () => ({
  generateVideoThumbnail: async () => null,
}));

// ── Mock IPC blob store ────────────────────────────────────────────────────

mock.module('../daemon/ipc-blob-store.js', () => ({
  isValidBlobId: () => false,
  resolveBlobPath: () => '',
  deleteBlob: noop,
}));

// ── Mock channels/types ────────────────────────────────────────────────────

mock.module('../channels/types.js', () => ({
  parseChannelId: () => 'vellum',
  parseInterfaceId: () => 'vellum',
  isChannelId: () => true,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import type { HandlerContext } from '../daemon/handlers/shared.js';
import { DebouncerMap } from '../util/debounce.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createCtx(overrides?: Partial<HandlerContext>): {
  ctx: HandlerContext;
  sent: Array<{ type: string; [k: string]: unknown }>;
  fakeSocket: net.Socket;
} {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];
  const fakeSocket = {} as net.Socket;
  const socketToSession = new Map<net.Socket, string>();

  // Create a fake session that fulfills minimum interface for handleUserMessage
  const fakeSession = {
    hasEscalationHandler: () => true,
    setEscalationHandler: noop,
    traceEmitter: { emit: noop },
    enqueueMessage: () => ({ rejected: false, queued: false }),
    setTurnChannelContext: noop,
    setTurnInterfaceContext: noop,
    setAssistantId: noop,
    setGuardianContext: noop,
    setCommandIntent: noop,
    processMessage: async () => {},
    getQueueDepth: () => 0,
    setPreactivatedSkillIds: noop,
    redirectToSecurePrompt: noop,
  };

  const sessions = new Map<string, any>();

  const ctx: HandlerContext = {
    sessions,
    socketToSession,
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: noop,
    updateConfigFingerprint: noop,
    send: (_socket, msg) => { sent.push(msg as { type: string; [k: string]: unknown }); },
    broadcast: noop,
    clearAllSessions: () => 0,
    getOrCreateSession: async (conversationId: string) => {
      sessions.set(conversationId, fakeSession);
      return fakeSession as any;
    },
    touchSession: noop,
    ...overrides,
  };

  return { ctx, sent, fakeSocket };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('recording intent handler integration — handleTaskSubmit', () => {
  beforeEach(() => {
    mockResolveResult = { kind: 'none' };
    mockAssistantName = null;
    recordingStartCalled = false;
    recordingStopCalled = false;
    classifierCalled = false;
  });

  test('start_only → calls handleRecordingStart, sends task_routed + text_delta + message_complete, returns early', async () => {
    mockResolveResult = { kind: 'start_only' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'record my screen', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingStartCalled).toBe(true);
    expect(recordingStopCalled).toBe(false);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');
  });

  test('stop_only → calls handleRecordingStop, sends task_routed + text_delta + message_complete, returns early', async () => {
    mockResolveResult = { kind: 'stop_only' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'stop recording', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingStopCalled).toBe(true);
    expect(recordingStartCalled).toBe(false);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');
  });

  test('start_with_remainder → defers recording start, falls through to classifier with remainder text', async () => {
    mockResolveResult = { kind: 'start_with_remainder', remainder: 'open Safari' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'open Safari and record my screen', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    // Recording start is deferred but still triggered as a side effect
    expect(recordingStartCalled).toBe(true);
    expect(recordingStopCalled).toBe(false);
    // Classifier runs on the remainder text
    expect(classifierCalled).toBe(true);
  });

  test('none → does NOT call handleRecordingStart/Stop, falls through to classifier', async () => {
    mockResolveResult = { kind: 'none' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'hello world', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingStartCalled).toBe(false);
    expect(recordingStopCalled).toBe(false);
    expect(classifierCalled).toBe(true);
  });
});

describe('recording intent handler integration — handleUserMessage', () => {
  beforeEach(() => {
    mockResolveResult = { kind: 'none' };
    mockAssistantName = null;
    recordingStartCalled = false;
    recordingStopCalled = false;
    classifierCalled = false;
  });

  test('start_only → calls handleRecordingStart, sends text_delta + message_complete, returns early', async () => {
    mockResolveResult = { kind: 'start_only' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'record my screen',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingStartCalled).toBe(true);
    expect(recordingStopCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    // Should not proceed to enqueueMessage — the message_complete means it returned early
    // The absence of enqueueMessage side effects is hard to test directly,
    // but we verify message_complete was the last message sent.
    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('stop_only → calls handleRecordingStop, sends text_delta + message_complete, returns early', async () => {
    mockResolveResult = { kind: 'stop_only' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'stop recording',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingStopCalled).toBe(true);
    expect(recordingStartCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('start_with_remainder → defers recording start, proceeds to normal message processing with remainder', async () => {
    mockResolveResult = { kind: 'start_with_remainder', remainder: 'open Safari' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'open Safari and record my screen',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    // Recording start is deferred but triggered as a side effect
    expect(recordingStartCalled).toBe(true);
    expect(recordingStopCalled).toBe(false);
  });

  test('none → does NOT intercept, proceeds to normal message processing', async () => {
    mockResolveResult = { kind: 'none' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'hello world',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingStartCalled).toBe(false);
    expect(recordingStopCalled).toBe(false);

    // Should NOT have recording-specific messages
    const recordingSpecific = sent.filter(
      (m) => m.type === 'assistant_text_delta' && typeof m.text === 'string' &&
        (m.text.includes('Starting screen recording') || m.text.includes('Stopping the recording')),
    );
    expect(recordingSpecific).toHaveLength(0);
  });
});

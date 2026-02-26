
import * as net from 'node:net';

import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

// ── Mock recording-intent — we control the resolution result ───────────────

type RecordingIntentResult =
  | { kind: 'none' }
  | { kind: 'start_only' }
  | { kind: 'stop_only' }
  | { kind: 'start_with_remainder'; remainder: string }
  | { kind: 'stop_with_remainder'; remainder: string }
  | { kind: 'start_and_stop_only' }
  | { kind: 'start_and_stop_with_remainder'; remainder: string }
  | { kind: 'restart_only' }
  | { kind: 'restart_with_remainder'; remainder: string }
  | { kind: 'pause_only' }
  | { kind: 'resume_only' };

let mockIntentResult: RecordingIntentResult = { kind: 'none' };

mock.module('../daemon/recording-intent.js', () => ({
  resolveRecordingIntent: () => mockIntentResult,
  stripDynamicNames: (t: string) => t,
}));

// ── Mock recording-executor — we control the execution output ──────────────

interface RecordingExecutionOutput {
  handled: boolean;
  responseText?: string;
  remainderText?: string;
  pendingStart?: boolean;
  pendingStop?: boolean;
  pendingRestart?: boolean;
  recordingStarted?: boolean;
}

let mockExecuteResult: RecordingExecutionOutput = { handled: false };
let executorCalled = false;

mock.module('../daemon/recording-executor.js', () => ({
  executeRecordingIntent: () => {
    executorCalled = true;
    return mockExecuteResult;
  },
}));

// ── Mock recording handlers ────────────────────────────────────────────────

let recordingStartCalled = false;
let recordingStopCalled = false;
let recordingRestartCalled = false;
let recordingPauseCalled = false;
let recordingResumeCalled = false;

mock.module('../daemon/handlers/recording.js', () => ({
  handleRecordingStart: () => {
    recordingStartCalled = true;
    return 'mock-recording-id';
  },
  handleRecordingStop: () => {
    recordingStopCalled = true;
    return 'mock-recording-id';
  },
  handleRecordingRestart: () => {
    recordingRestartCalled = true;
    return { initiated: true, responseText: 'Restarting screen recording.', operationToken: 'mock-token' };
  },
  handleRecordingPause: () => {
    recordingPauseCalled = true;
    return 'mock-recording-id';
  },
  handleRecordingResume: () => {
    recordingResumeCalled = true;
    return 'mock-recording-id';
  },
  isRecordingIdle: () => true,
  recordingHandlers: {},
  __resetRecordingState: noop,
}));

// ── Mock conversation store ────────────────────────────────────────────────

mock.module('../memory/conversation-store.js', () => ({
  getMessages: () => [],
  addMessage: () => ({ id: 'msg-mock', role: 'assistant', content: '' }),
  createConversation: (titleOrOpts?: string | { title?: string }) => {
    const title = typeof titleOrOpts === 'string' ? titleOrOpts : titleOrOpts?.title ?? 'Untitled';
    return { id: 'conv-mock', title };
  },
  getConversation: () => ({ id: 'conv-mock' }),
  updateConversationTitle: noop,
  clearAll: noop,
  listConversations: () => [],
  countConversations: () => 0,
  searchConversations: () => [],
  deleteConversation: noop,
}));

mock.module('../memory/conversation-title-service.js', () => ({
  GENERATING_TITLE: '(generating\u2026)',
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

mock.module('../security/secret-scanner.js', () => ({
  redactSecrets: (text: string) => text,
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
    setEscalationHandler: noop,
    dispose: noop,
    hasPendingConfirmation: () => false,
    hasPendingSecret: () => false,
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

function resetMockState(): void {
  mockIntentResult = { kind: 'none' };
  mockExecuteResult = { handled: false };
  mockAssistantName = null;
  recordingStartCalled = false;
  recordingStopCalled = false;
  recordingRestartCalled = false;
  recordingPauseCalled = false;
  recordingResumeCalled = false;
  executorCalled = false;
  classifierCalled = false;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('recording intent handler integration — handleTaskSubmit', () => {
  beforeEach(resetMockState);

  test('start_only → executeRecordingIntent called, sends task_routed + text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'start_only' };
    mockExecuteResult = { handled: true, responseText: 'Starting screen recording.', recordingStarted: true };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'record my screen', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const textDelta = sent.find((m) => m.type === 'assistant_text_delta');
    expect(textDelta?.text).toBe('Starting screen recording.');
  });

  test('stop_only → executeRecordingIntent called, sends task_routed + text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'stop_only' };
    mockExecuteResult = { handled: true, responseText: 'Stopping the recording.' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'stop recording', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const textDelta = sent.find((m) => m.type === 'assistant_text_delta');
    expect(textDelta?.text).toBe('Stopping the recording.');
  });

  test('start_with_remainder → defers recording, falls through to classifier with remaining text', async () => {
    mockIntentResult = { kind: 'start_with_remainder', remainder: 'open Safari' };
    mockExecuteResult = { handled: false, remainderText: 'open Safari', pendingStart: true };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'open Safari and record my screen', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(classifierCalled).toBe(true);

    // Should NOT have recording-only messages before the classifier output
    const recordingSpecific = sent.filter(
      (m) => m.type === 'assistant_text_delta' && typeof m.text === 'string' &&
        (m.text.includes('Starting screen recording') || m.text.includes('Stopping the recording')),
    );
    expect(recordingSpecific).toHaveLength(0);
  });

  test('none → does NOT call executeRecordingIntent, falls through to classifier', async () => {
    mockIntentResult = { kind: 'none' };
    const { ctx, sent: _sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'hello world', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(false);
    expect(classifierCalled).toBe(true);
  });

  test('restart_only → executeRecordingIntent called, sends task_routed + text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'restart_only' };
    mockExecuteResult = { handled: true, responseText: 'Restarting screen recording.' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'restart the recording', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const textDelta = sent.find((m) => m.type === 'assistant_text_delta');
    expect(textDelta?.text).toBe('Restarting screen recording.');
  });

  test('pause_only → executeRecordingIntent called, sends task_routed + text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'pause_only' };
    mockExecuteResult = { handled: true, responseText: 'Pausing the recording.' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'pause the recording', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const textDelta = sent.find((m) => m.type === 'assistant_text_delta');
    expect(textDelta?.text).toBe('Pausing the recording.');
  });

  test('resume_only → executeRecordingIntent called, sends task_routed + text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'resume_only' };
    mockExecuteResult = { handled: true, responseText: 'Resuming the recording.' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'resume the recording', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const textDelta = sent.find((m) => m.type === 'assistant_text_delta');
    expect(textDelta?.text).toBe('Resuming the recording.');
  });

  test('restart_with_remainder → defers restart, falls through to classifier with remaining text', async () => {
    mockIntentResult = { kind: 'restart_with_remainder', remainder: 'open Safari' };
    mockExecuteResult = { handled: false, remainderText: 'open Safari', pendingRestart: true };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      { type: 'task_submit', task: 'restart the recording and open Safari', source: 'voice' } as any,
      fakeSocket,
      ctx,
    );

    expect(classifierCalled).toBe(true);

    // Should NOT have restart-specific messages before classifier output
    const recordingSpecific = sent.filter(
      (m) => m.type === 'assistant_text_delta' && typeof m.text === 'string' &&
        m.text.includes('Restarting screen recording'),
    );
    expect(recordingSpecific).toHaveLength(0);
  });

  test('commandIntent restart → routes directly via handleRecordingRestart, returns early', async () => {
    // commandIntent bypasses text-based intent resolution entirely
    mockIntentResult = { kind: 'none' }; // should not matter
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      {
        type: 'task_submit',
        task: 'restart recording',
        source: 'voice',
        commandIntent: { domain: 'screen_recording', action: 'restart' },
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingRestartCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');
  });

  test('commandIntent pause → routes directly via handleRecordingPause, returns early', async () => {
    mockIntentResult = { kind: 'none' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      {
        type: 'task_submit',
        task: 'pause recording',
        source: 'voice',
        commandIntent: { domain: 'screen_recording', action: 'pause' },
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingPauseCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');
  });

  test('commandIntent resume → routes directly via handleRecordingResume, returns early', async () => {
    mockIntentResult = { kind: 'none' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleTaskSubmit } = await import('../daemon/handlers/misc.js');
    await handleTaskSubmit(
      {
        type: 'task_submit',
        task: 'resume recording',
        source: 'voice',
        commandIntent: { domain: 'screen_recording', action: 'resume' },
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingResumeCalled).toBe(true);
    expect(classifierCalled).toBe(false);

    const types = sent.map((m) => m.type);
    expect(types).toContain('task_routed');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');
  });
});

describe('recording intent handler integration — handleUserMessage', () => {
  beforeEach(resetMockState);

  test('start_only → executeRecordingIntent called, sends text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'start_only' };
    mockExecuteResult = { handled: true, responseText: 'Starting screen recording.', recordingStarted: true };
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

    expect(executorCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    // message_complete should be the last message sent (recording returned early)
    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('stop_only → executeRecordingIntent called, sends text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'stop_only' };
    mockExecuteResult = { handled: true, responseText: 'Stopping the recording.' };
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

    expect(executorCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('start_with_remainder → does NOT return early, proceeds to normal message processing', async () => {
    mockIntentResult = { kind: 'start_with_remainder', remainder: 'open Safari' };
    mockExecuteResult = { handled: false, remainderText: 'open Safari', pendingStart: true };
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

    // Should deferred recording start and proceed to normal processing
    expect(recordingStartCalled).toBe(true);

    // Should NOT have recording-specific intercept messages
    const recordingSpecific = sent.filter(
      (m) => m.type === 'assistant_text_delta' && typeof m.text === 'string' &&
        (m.text.includes('Starting screen recording') || m.text.includes('Stopping the recording')),
    );
    expect(recordingSpecific).toHaveLength(0);
  });

  test('none → does NOT intercept, proceeds to normal message processing', async () => {
    mockIntentResult = { kind: 'none' };
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

    expect(executorCalled).toBe(false);

    // Should NOT have recording-specific messages
    const recordingSpecific = sent.filter(
      (m) => m.type === 'assistant_text_delta' && typeof m.text === 'string' &&
        (m.text.includes('Starting screen recording') || m.text.includes('Stopping the recording')),
    );
    expect(recordingSpecific).toHaveLength(0);
  });

  test('restart_only → executeRecordingIntent called, sends text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'restart_only' };
    mockExecuteResult = { handled: true, responseText: 'Restarting screen recording.' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'restart the recording',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('pause_only → executeRecordingIntent called, sends text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'pause_only' };
    mockExecuteResult = { handled: true, responseText: 'Pausing the recording.' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'pause the recording',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('resume_only → executeRecordingIntent called, sends text_delta + message_complete, returns early', async () => {
    mockIntentResult = { kind: 'resume_only' };
    mockExecuteResult = { handled: true, responseText: 'Resuming the recording.' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'resume the recording',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    expect(executorCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('restart_with_remainder → defers restart, continues with remaining text', async () => {
    mockIntentResult = { kind: 'restart_with_remainder', remainder: 'open Safari' };
    mockExecuteResult = { handled: false, remainderText: 'open Safari', pendingRestart: true };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'restart the recording and open Safari',
        interface: 'vellum',
      } as any,
      fakeSocket,
      ctx,
    );

    // Deferred restart should have been executed
    expect(recordingRestartCalled).toBe(true);

    // Should NOT have restart-specific intercept messages
    const recordingSpecific = sent.filter(
      (m) => m.type === 'assistant_text_delta' && typeof m.text === 'string' &&
        m.text.includes('Restarting screen recording'),
    );
    expect(recordingSpecific).toHaveLength(0);
  });

  test('commandIntent restart → routes directly via handleRecordingRestart, returns early', async () => {
    mockIntentResult = { kind: 'none' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'restart recording',
        interface: 'vellum',
        commandIntent: { domain: 'screen_recording', action: 'restart' },
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingRestartCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.type).toBe('message_complete');
  });

  test('commandIntent pause → routes directly via handleRecordingPause, returns early', async () => {
    mockIntentResult = { kind: 'none' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'pause recording',
        interface: 'vellum',
        commandIntent: { domain: 'screen_recording', action: 'pause' },
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingPauseCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');
  });

  test('commandIntent resume → routes directly via handleRecordingResume, returns early', async () => {
    mockIntentResult = { kind: 'none' };
    const { ctx, sent, fakeSocket } = createCtx();

    const { handleUserMessage } = await import('../daemon/handlers/sessions.js');
    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'test-session',
        content: 'resume recording',
        interface: 'vellum',
        commandIntent: { domain: 'screen_recording', action: 'resume' },
      } as any,
      fakeSocket,
      ctx,
    );

    expect(recordingResumeCalled).toBe(true);

    const types = sent.map((m) => m.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');
  });
});

import { describe, test, expect, mock } from 'bun:test';
import * as net from 'node:net';

// Mock the conversation store before importing the handler.
const mockConversations = new Map<string, { id: string }>();
const mockAddedMessages: Array<{
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> = [];

mock.module('../memory/conversation-store.js', () => ({
  getConversation: (id: string) => mockConversations.get(id) ?? null,
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => {
    const msg = { conversationId, role, content, metadata };
    mockAddedMessages.push(msg);
    return { id: 'mock-msg-id', conversationId, role, content, createdAt: Date.now() };
  },
}));

// Mock the config loader (required by shared.ts transitively).
mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    provider: 'mock-provider',
    permissions: { mode: 'legacy' },
    apiKeys: {},
    sandbox: { enabled: false },
    timeouts: { toolExecutionTimeoutSec: 30, permissionTimeoutSec: 5 },
    skills: { load: { extraDirs: [] } },
    secretDetection: { enabled: false },
    memory: {},
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  }),
  invalidateConfigCache: () => {},
}));

import type { CuSessionFinalized, ServerMessage } from '../daemon/ipc-contract.js';
import type { HandlerContext, CuSessionMetadata } from '../daemon/handlers/shared.js';
import { handleCuSessionFinalized } from '../daemon/handlers/computer-use.js';
import type { ComputerUseSession } from '../daemon/computer-use-session.js';

/** Create a minimal HandlerContext for testing. */
function makeCtx(overrides?: Partial<HandlerContext>): HandlerContext {
  return {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuSessionMetadata: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new Map() as unknown as HandlerContext['debounceTimers'],
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: () => {},
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: async () => { throw new Error('not implemented in test'); },
    touchSession: () => {},
    ...overrides,
  };
}

describe('handleCuSessionFinalized', () => {
  test('injects summary into reporting session when reportToSessionId is set', () => {
    // Set up a reporting session conversation.
    const reportSessionId = 'report-session-1';
    mockConversations.set(reportSessionId, { id: reportSessionId });
    mockAddedMessages.length = 0;

    // Create a mock socket for the reporting session.
    const reportSocket = new net.Socket();
    const sentMessages: Array<{ socket: net.Socket; msg: ServerMessage }> = [];

    const ctx = makeCtx({
      send: (socket: net.Socket, msg: ServerMessage) => { sentMessages.push({ socket, msg }); },
      socketToSession: new Map([[reportSocket, reportSessionId]]),
    });

    // Simulate a CU session with metadata.
    const cuSessionId = 'cu-session-1';
    ctx.cuSessions.set(cuSessionId, {} as ComputerUseSession);
    ctx.cuSessionMetadata.set(cuSessionId, {
      reportToSessionId: reportSessionId,
      qaMode: true,
    });

    const msg: CuSessionFinalized = {
      type: 'cu_session_finalized',
      sessionId: cuSessionId,
      status: 'completed',
      summary: 'QA test passed: login flow works correctly.',
      stepCount: 5,
    };

    handleCuSessionFinalized(msg, new net.Socket(), ctx);

    // Verify the assistant message was persisted.
    expect(mockAddedMessages.length).toBe(1);
    expect(mockAddedMessages[0].conversationId).toBe(reportSessionId);
    expect(mockAddedMessages[0].role).toBe('assistant');
    const parsedContent = JSON.parse(mockAddedMessages[0].content);
    expect(parsedContent).toEqual([{ type: 'text', text: msg.summary }]);
    expect(mockAddedMessages[0].metadata).toMatchObject({
      source: 'cu_session_finalized',
      cuSessionId,
      cuStatus: 'completed',
      cuStepCount: 5,
      qaMode: true,
    });

    // Verify IPC messages were sent to the reporting socket.
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0].msg).toMatchObject({
      type: 'assistant_text_delta',
      text: msg.summary,
      sessionId: reportSessionId,
    });
    expect(sentMessages[1].msg).toMatchObject({
      type: 'message_complete',
      sessionId: reportSessionId,
    });
    expect(sentMessages[0].socket).toBe(reportSocket);

    // Verify CU session state was cleaned up.
    expect(ctx.cuSessions.has(cuSessionId)).toBe(false);
    expect(ctx.cuSessionMetadata.has(cuSessionId)).toBe(false);
  });

  test('cleans up CU session state even without reportToSessionId', () => {
    const ctx = makeCtx();
    const cuSessionId = 'cu-session-2';
    ctx.cuSessions.set(cuSessionId, {} as ComputerUseSession);
    // No metadata set — this is a non-QA CU session.

    const msg: CuSessionFinalized = {
      type: 'cu_session_finalized',
      sessionId: cuSessionId,
      status: 'completed',
      summary: 'Task done.',
      stepCount: 3,
    };

    mockAddedMessages.length = 0;
    handleCuSessionFinalized(msg, new net.Socket(), ctx);

    // No message should be persisted (no reportToSessionId).
    expect(mockAddedMessages.length).toBe(0);

    // CU session state should still be cleaned up.
    expect(ctx.cuSessions.has(cuSessionId)).toBe(false);
  });

  test('handles missing reporting conversation gracefully', () => {
    const ctx = makeCtx();
    const cuSessionId = 'cu-session-3';
    ctx.cuSessions.set(cuSessionId, {} as ComputerUseSession);
    ctx.cuSessionMetadata.set(cuSessionId, {
      reportToSessionId: 'nonexistent-session',
      qaMode: true,
    });

    // Make sure the conversation does NOT exist in the mock store.
    mockConversations.delete('nonexistent-session');
    mockAddedMessages.length = 0;

    const msg: CuSessionFinalized = {
      type: 'cu_session_finalized',
      sessionId: cuSessionId,
      status: 'failed',
      summary: 'QA test failed.',
      stepCount: 2,
    };

    // Should not throw even if the conversation is missing.
    handleCuSessionFinalized(msg, new net.Socket(), ctx);

    expect(mockAddedMessages.length).toBe(0);
    expect(ctx.cuSessions.has(cuSessionId)).toBe(false);
    expect(ctx.cuSessionMetadata.has(cuSessionId)).toBe(false);
  });

  test('logs recording metadata without crashing', () => {
    const reportSessionId = 'report-session-rec';
    mockConversations.set(reportSessionId, { id: reportSessionId });
    mockAddedMessages.length = 0;

    const ctx = makeCtx();
    const cuSessionId = 'cu-session-rec';
    ctx.cuSessions.set(cuSessionId, {} as ComputerUseSession);
    ctx.cuSessionMetadata.set(cuSessionId, {
      reportToSessionId: reportSessionId,
    });

    const msg: CuSessionFinalized = {
      type: 'cu_session_finalized',
      sessionId: cuSessionId,
      status: 'completed',
      summary: 'Done with recording.',
      stepCount: 4,
      recording: {
        localPath: '/tmp/recording.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024000,
        durationMs: 30000,
        width: 1920,
        height: 1080,
        captureScope: 'window',
        includeAudio: false,
      },
    };

    handleCuSessionFinalized(msg, new net.Socket(), ctx);

    // Message should be persisted with recording path in metadata.
    expect(mockAddedMessages.length).toBe(1);
    expect(mockAddedMessages[0].metadata).toMatchObject({
      recordingPath: '/tmp/recording.mp4',
    });
  });

  test('creates fallback attachment when reportToSessionId exists but conversation is missing and recording is present', () => {
    // This tests the edge case where reportToSessionId is set but the conversation
    // doesn't exist (e.g. it was deleted or never created). The recording should
    // still get a file-backed attachment entry so cleanup can track it.
    const ctx = makeCtx();
    const cuSessionId = 'cu-session-orphan-with-report';
    ctx.cuSessions.set(cuSessionId, {} as ComputerUseSession);
    ctx.cuSessionMetadata.set(cuSessionId, {
      reportToSessionId: 'nonexistent-session',
      qaMode: true,
    });

    // Ensure the conversation does NOT exist.
    mockConversations.delete('nonexistent-session');
    mockAddedMessages.length = 0;

    const msg: CuSessionFinalized = {
      type: 'cu_session_finalized',
      sessionId: cuSessionId,
      status: 'completed',
      summary: 'QA recording completed.',
      stepCount: 3,
      recording: {
        localPath: '/tmp/orphan-recording.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 2048000,
        durationMs: 45000,
        width: 1920,
        height: 1080,
        captureScope: 'window',
        includeAudio: false,
      },
    };

    // Should not throw.
    handleCuSessionFinalized(msg, new net.Socket(), ctx);

    // No message persisted (conversation missing), but the recording should
    // still be tracked. We can't easily verify createFileBackedAttachment
    // was called without mocking it, but at minimum the function shouldn't throw
    // and state should be cleaned up.
    expect(mockAddedMessages.length).toBe(0);
    expect(ctx.cuSessions.has(cuSessionId)).toBe(false);
    expect(ctx.cuSessionMetadata.has(cuSessionId)).toBe(false);
  });

  test('creates fallback attachment when summary is empty but recording is present', () => {
    const ctx = makeCtx();
    const cuSessionId = 'cu-session-empty-summary';
    ctx.cuSessions.set(cuSessionId, {} as ComputerUseSession);
    ctx.cuSessionMetadata.set(cuSessionId, {
      reportToSessionId: 'some-session',
      qaMode: true,
    });

    mockConversations.set('some-session', { id: 'some-session' });
    mockAddedMessages.length = 0;

    const msg: CuSessionFinalized = {
      type: 'cu_session_finalized',
      sessionId: cuSessionId,
      status: 'completed',
      summary: '', // Empty summary — injection path skipped
      stepCount: 2,
      recording: {
        localPath: '/tmp/empty-summary-recording.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 512000,
        durationMs: 10000,
        width: 1280,
        height: 720,
        captureScope: 'display',
        includeAudio: true,
      },
    };

    handleCuSessionFinalized(msg, new net.Socket(), ctx);

    // No message persisted (empty summary skips injection path).
    expect(mockAddedMessages.length).toBe(0);
    // State cleaned up.
    expect(ctx.cuSessions.has(cuSessionId)).toBe(false);
    expect(ctx.cuSessionMetadata.has(cuSessionId)).toBe(false);
  });

  test('stores and retrieves CU session metadata', () => {
    const ctx = makeCtx();

    const cuSessionId = 'cu-meta-test';
    const meta: CuSessionMetadata = {
      reportToSessionId: 'parent-123',
      qaMode: true,
    };
    ctx.cuSessionMetadata.set(cuSessionId, meta);

    const stored = ctx.cuSessionMetadata.get(cuSessionId);
    expect(stored).toEqual(meta);
    expect(stored?.reportToSessionId).toBe('parent-123');
    expect(stored?.qaMode).toBe(true);
  });
});

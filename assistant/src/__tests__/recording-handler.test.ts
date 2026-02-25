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

// Conversation store mock
const mockMessages: Array<{ id: string; role: string; content: string }> = [];
let mockMessageIdCounter = 0;

mock.module('../memory/conversation-store.js', () => ({
  getMessages: () => mockMessages,
  addMessage: (_convId: string, role: string, content: string) => {
    const msg = { id: `msg-${++mockMessageIdCounter}`, role, content };
    mockMessages.push(msg);
    return msg;
  },
  createConversation: () => ({ id: 'conv-mock' }),
  getConversation: () => ({ id: 'conv-mock' }),
}));

// Attachments store mock
const mockAttachments: Array<{ id: string; originalFilename: string; mimeType: string; sizeBytes: number }> = [];
let mockAttachmentIdCounter = 0;

mock.module('../memory/attachments-store.js', () => ({
  uploadFileBackedAttachment: (filename: string, mimeType: string, _filePath: string, sizeBytes: number) => {
    const att = { id: `att-${++mockAttachmentIdCounter}`, originalFilename: filename, mimeType, sizeBytes };
    mockAttachments.push(att);
    return att;
  },
  linkAttachmentToMessage: noop,
}));

// Mock node:fs for file existence checks in the recording handler
let mockFileExists = true;
let mockFileSize = 1024;

mock.module('node:fs', () => {
  // Re-export real fs for non-mocked functions and add our overrides
  const realFs = require('fs');
  return {
    ...realFs,
    existsSync: (p: string) => {
      // Only intercept paths that look like recording files
      if (p.includes('recording') || p.includes('/tmp/')) return mockFileExists;
      return realFs.existsSync(p);
    },
    statSync: (p: string, opts?: any) => {
      if (p.includes('recording') || p.includes('/tmp/')) return { size: mockFileSize };
      return realFs.statSync(p, opts);
    },
  };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { handleRecordingStart, handleRecordingStop, recordingHandlers } from '../daemon/handlers/recording.js';
import type { HandlerContext } from '../daemon/handlers/shared.js';
import type { RecordingStatus } from '../daemon/ipc-contract/computer-use.js';
import { DebouncerMap } from '../util/debounce.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

function createCtx(): { ctx: HandlerContext; sent: Array<{ type: string; [k: string]: unknown }>; fakeSocket: net.Socket } {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];
  const fakeSocket = {} as net.Socket;
  const socketToSession = new Map<net.Socket, string>();

  const ctx: HandlerContext = {
    sessions: new Map(),
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
    getOrCreateSession: () => { throw new Error('not implemented'); },
    touchSession: noop,
  };

  return { ctx, sent, fakeSocket };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleRecordingStart', () => {
  beforeEach(() => {
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test('sends recording_start IPC and returns a UUID', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-1';

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);

    expect(recordingId).toBeTruthy();
    // UUID v4 format
    expect(recordingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('recording_start');
    expect(sent[0].recordingId).toBe(recordingId);
    expect(sent[0].attachToConversationId).toBe(conversationId);
  });

  test('passes recording options through', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const options = { captureScope: 'window' as const, includeAudio: true };

    handleRecordingStart('conv-2', options, fakeSocket, ctx);

    expect(sent[0].options).toEqual(options);
  });

  test('returns null when recording already active and sends no messages', () => {
    const { ctx, sent, fakeSocket } = createCtx();

    const id1 = handleRecordingStart('conv-3', undefined, fakeSocket, ctx);
    expect(id1).toBeTruthy();

    const id2 = handleRecordingStart('conv-3', undefined, fakeSocket, ctx);

    // Should return null (callers handle messaging)
    expect(id2).toBeNull();
    // Only the first call sends recording_start — the duplicate sends nothing
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('recording_start');
    expect(sent[0].recordingId).toBe(id1);
  });
});

describe('handleRecordingStop', () => {
  beforeEach(() => {
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test('sends recording_stop for an active recording', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-stop-1';

    // Bind socket to session so findSocketForSession can locate it
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start a recording first
    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0; // Clear the start message

    const result = handleRecordingStop(conversationId, ctx);

    expect(result).toBe(recordingId);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('recording_stop');
    expect(sent[0].recordingId).toBe(recordingId);
  });

  test('returns undefined when no active recording exists', () => {
    const { ctx } = createCtx();

    const result = handleRecordingStop('conv-no-recording', ctx);

    expect(result).toBeUndefined();
  });

  test('returns undefined when no socket bound to conversation', () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = 'conv-no-socket';

    // Start a recording (socket is used for the start message)
    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    // Do NOT bind the socket to the session in socketToSession

    const result = handleRecordingStop(conversationId, ctx);

    // No socket -> returns undefined after cleanup
    expect(result).toBeUndefined();
  });
});

describe('recordingHandlers.recording_status', () => {
  beforeEach(() => {
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test('handles started status without errors', () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = 'conv-status-1';

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId,
      status: 'started',
    };

    // Should not throw
    expect(() => {
      recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);
    }).not.toThrow();
  });

  test('handles stopped status with file — creates attachment and notifies client', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-status-stopped';

    // Bind socket
    ctx.socketToSession.set(fakeSocket, conversationId);

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    // Add a mock assistant message for the attachment to link to
    mockMessages.push({ id: 'existing-msg', role: 'assistant', content: 'Hello' });

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId,
      status: 'stopped',
      filePath: '/tmp/recording.mov',
      durationMs: 5000,
    };

    recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);

    // Should have sent assistant_text_delta and message_complete
    const textDeltas = sent.filter((m) => m.type === 'assistant_text_delta');
    const completes = sent.filter((m) => m.type === 'message_complete');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(completes.length).toBeGreaterThanOrEqual(1);

    // The message_complete should include attachment info
    const completeMsg = completes[0];
    expect(completeMsg.sessionId).toBe(conversationId);

    // Attachment should have been created
    expect(mockAttachments.length).toBe(1);
    expect(mockAttachments[0].mimeType).toBe('video/quicktime');
    expect(mockAttachments[0].sizeBytes).toBe(mockFileSize);
  });

  test('handles stopped status and creates assistant message when none exists', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-status-no-msg';

    ctx.socketToSession.set(fakeSocket, conversationId);

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    // No existing messages, handler should create one

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId,
      status: 'stopped',
      filePath: '/tmp/recording.mp4',
      durationMs: 3000,
    };

    recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);

    // An assistant message should have been created via addMessage mock
    expect(mockMessages.length).toBeGreaterThanOrEqual(1);
    const createdMsg = mockMessages.find((m) => m.role === 'assistant');
    expect(createdMsg).toBeTruthy();
  });

  test('handles stopped status when file does not exist', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-status-no-file';

    ctx.socketToSession.set(fakeSocket, conversationId);
    mockFileExists = false;

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId,
      status: 'stopped',
      filePath: '/tmp/nonexistent.mov',
      durationMs: 1000,
    };

    // Should not throw — the handler logs the error and skips attachment
    expect(() => {
      recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);
    }).not.toThrow();

    // No attachment should have been created
    expect(mockAttachments.length).toBe(0);
  });

  test('handles failed status and notifies client', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-status-failed';

    ctx.socketToSession.set(fakeSocket, conversationId);

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId,
      status: 'failed',
      error: 'Permission denied',
    };

    recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);

    // Should send error notification
    const textDeltas = sent.filter((m) => m.type === 'assistant_text_delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain('Recording failed');
    expect(textDeltas[0].text).toContain('Permission denied');

    const completes = sent.filter((m) => m.type === 'message_complete');
    expect(completes.length).toBeGreaterThanOrEqual(1);
  });

  test('handles failed status with no error message', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-status-failed-no-err';

    ctx.socketToSession.set(fakeSocket, conversationId);

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId,
      status: 'failed',
    };

    recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);

    const textDeltas = sent.filter((m) => m.type === 'assistant_text_delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain('unknown error');
  });

  test('handles status with attachToConversationId fallback', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-fallback';

    ctx.socketToSession.set(fakeSocket, conversationId);

    // Send a recording_status directly with attachToConversationId
    // without having started a recording through handleRecordingStart
    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: 'unknown-recording-id',
      status: 'failed',
      error: 'Something went wrong',
      attachToConversationId: conversationId,
    };

    // Should not throw — uses attachToConversationId as fallback
    expect(() => {
      recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);
    }).not.toThrow();

    const textDeltas = sent.filter((m) => m.type === 'assistant_text_delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
  });
});

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
mock.module('../memory/attachments-store.js', () => ({
  uploadFileBackedAttachment: () => ({ id: 'att-mock', originalFilename: 'test.mov', mimeType: 'video/quicktime', sizeBytes: 1024 }),
  linkAttachmentToMessage: noop,
  setAttachmentThumbnail: noop,
}));

// Mock node:fs
mock.module('node:fs', () => {
  const realFs = require('fs');
  return {
    ...realFs,
    existsSync: (p: string) => {
      if (p.includes('recording') || p.includes('/tmp/')) return true;
      return realFs.existsSync(p);
    },
    statSync: (p: string, opts?: any) => {
      if (p.includes('recording') || p.includes('/tmp/')) return { size: 1024 };
      return realFs.statSync(p, opts);
    },
  };
});

// Mock video thumbnail
mock.module('../daemon/video-thumbnail.js', () => ({
  generateVideoThumbnailFromPath: async () => null,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  handleRecordingStart,
  handleRecordingStop,
  handleRecordingRestart,
  handleRecordingPause,
  handleRecordingResume,
  isRecordingIdle,
  getActiveRestartToken,
  recordingHandlers,
  __resetRecordingState,
} from '../daemon/handlers/recording.js';
import { executeRecordingIntent } from '../daemon/recording-executor.js';
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

// ─── Restart state machine tests ────────────────────────────────────────────

describe('handleRecordingRestart', () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test('stops current recording and starts a new one with operation token', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-restart-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start a recording first
    const originalId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    expect(originalId).not.toBeNull();
    sent.length = 0;

    const result = handleRecordingRestart(conversationId, fakeSocket, ctx);

    expect(result.initiated).toBe(true);
    expect(result.operationToken).toBeTruthy();
    expect(result.responseText).toBe('Restarting screen recording.');

    // Should have sent: recording_stop, recording_start
    const stopMsgs = sent.filter((m) => m.type === 'recording_stop');
    const startMsgs = sent.filter((m) => m.type === 'recording_start');
    expect(stopMsgs).toHaveLength(1);
    expect(startMsgs).toHaveLength(1);

    // The new recording_start should have the operation token
    expect(startMsgs[0].operationToken).toBe(result.operationToken);
  });

  test('returns "no active recording" with reason when nothing is recording', () => {
    const { ctx, fakeSocket } = createCtx();

    const result = handleRecordingRestart('conv-no-rec', fakeSocket, ctx);

    expect(result.initiated).toBe(false);
    expect(result.reason).toBe('no_active_recording');
    expect(result.responseText).toBe('No active recording to restart.');
  });

  test('generates unique operation token for each restart', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-restart-unique';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // First restart cycle
    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const result1 = handleRecordingRestart(conversationId, fakeSocket, ctx);

    // Simulate the first restart completing (started status)
    const startMsg1 = sent.filter((m) => m.type === 'recording_start').pop();
    const status1: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg1!.recordingId as string,
      status: 'started',
      operationToken: result1.operationToken,
    };
    recordingHandlers.recording_status(status1, fakeSocket, ctx);

    // Second restart cycle
    sent.length = 0;
    const result2 = handleRecordingRestart(conversationId, fakeSocket, ctx);

    expect(result1.operationToken).not.toBe(result2.operationToken);
  });
});

// ─── Restart cancel tests ───────────────────────────────────────────────────

describe('restart_cancelled status', () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test('emits restart_cancelled response, never "new recording started"', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-cancel-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start -> restart
    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);
    expect(restartResult.initiated).toBe(true);

    // Get the new recording ID from the recording_start message
    const startMsg = sent.filter((m) => m.type === 'recording_start').pop();
    sent.length = 0;

    // Client sends restart_cancelled (picker was closed) with the correct operation token
    const cancelStatus: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg!.recordingId as string,
      status: 'restart_cancelled',
      attachToConversationId: conversationId,
      operationToken: restartResult.operationToken,
    };
    recordingHandlers.recording_status(cancelStatus, fakeSocket, ctx);

    // Should have emitted the cancellation message
    const textDeltas = sent.filter((m) => m.type === 'assistant_text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe('Recording restart cancelled.');

    // Should NOT have "new recording started" anywhere
    const startedMsgs = sent.filter(
      (m) => m.type === 'assistant_text_delta' && typeof m.text === 'string' &&
        m.text.includes('new recording started'),
    );
    expect(startedMsgs).toHaveLength(0);

    // Recording should be truly idle after cancel
    expect(isRecordingIdle()).toBe(true);
  });

  test('cleans up restart state on cancel', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-cancel-cleanup';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);

    // Before cancel: not idle (mid-restart)
    expect(isRecordingIdle()).toBe(false);

    const startMsg = sent.filter((m) => m.type === 'recording_start').pop();
    const cancelStatus: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg!.recordingId as string,
      status: 'restart_cancelled',
      attachToConversationId: conversationId,
      operationToken: restartResult.operationToken,
    };
    recordingHandlers.recording_status(cancelStatus, fakeSocket, ctx);

    // After cancel: truly idle
    expect(isRecordingIdle()).toBe(true);
    expect(getActiveRestartToken()).toBeNull();
  });
});

// ─── Stale completion guard tests ───────────────────────────────────────────

describe('stale completion guard (operation token)', () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test('rejects recording_status with stale operation token', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-stale-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start recording -> restart (creates operation token)
    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);
    expect(restartResult.initiated).toBe(true);

    const startMsg = sent.filter((m) => m.type === 'recording_start').pop();
    sent.length = 0;

    // Simulate a stale "started" status from a PREVIOUS restart cycle
    const staleStatus: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg!.recordingId as string,
      status: 'started',
      operationToken: 'old-stale-token-from-previous-cycle',
    };
    recordingHandlers.recording_status(staleStatus, fakeSocket, ctx);

    // Should have been rejected — no "started" confirmation messages
    const textDeltas = sent.filter((m) => m.type === 'assistant_text_delta');
    expect(textDeltas).toHaveLength(0);

    // Active restart token should still be set (not cleared by stale completion)
    expect(getActiveRestartToken()).toBe(restartResult.operationToken);
  });

  test('accepts recording_status with matching operation token', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-matching-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);

    const startMsg = sent.filter((m) => m.type === 'recording_start').pop();

    // Send status with the CORRECT token
    const validStatus: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg!.recordingId as string,
      status: 'started',
      operationToken: restartResult.operationToken,
    };
    recordingHandlers.recording_status(validStatus, fakeSocket, ctx);

    // Should have been accepted — restart token cleared
    expect(getActiveRestartToken()).toBeNull();
  });

  test('rejects recording_status without operation token during active restart', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-tokenless-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start recording -> restart (creates operation token)
    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);
    expect(restartResult.initiated).toBe(true);

    const startMsg = sent.filter((m) => m.type === 'recording_start').pop();
    sent.length = 0;

    // Simulate a tokenless "started" status arriving during the restart
    // (e.g. from a previous non-restart recording cycle)
    const tokenlessStatus: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg!.recordingId as string,
      status: 'started',
      // No operationToken — should be rejected
    };
    recordingHandlers.recording_status(tokenlessStatus, fakeSocket, ctx);

    // Should have been rejected — no side effects
    const textDeltas = sent.filter((m) => m.type === 'assistant_text_delta');
    expect(textDeltas).toHaveLength(0);

    // Active restart token should still be set (not cleared by tokenless status)
    expect(getActiveRestartToken()).toBe(restartResult.operationToken);
  });

  test('no ghost state after restart stop/start handoff', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-ghost-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);

    // Restart cleans up old state atomically before starting new
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);
    expect(restartResult.initiated).toBe(true);

    // The new recording should be active (not the old one)
    const startMsgs = sent.filter((m) => m.type === 'recording_start');
    expect(startMsgs.length).toBeGreaterThanOrEqual(2); // original + restart

    // The last recording_start should have the operation token
    const lastStart = startMsgs[startMsgs.length - 1];
    expect(lastStart.operationToken).toBe(restartResult.operationToken);
  });
});

// ─── Pause/resume state transition tests ────────────────────────────────────

describe('handleRecordingPause', () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test('sends recording_pause for active recording', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-pause-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const result = handleRecordingPause(conversationId, ctx);

    expect(result).toBe(recordingId);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('recording_pause');
    expect(sent[0].recordingId).toBe(recordingId);
  });

  test('returns undefined when no active recording', () => {
    const { ctx } = createCtx();

    const result = handleRecordingPause('conv-no-rec', ctx);
    expect(result).toBeUndefined();
  });

  test('resolves to globally active recording from different conversation', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const convA = 'conv-owner-pause';
    ctx.socketToSession.set(fakeSocket, convA);

    const recordingId = handleRecordingStart(convA, undefined, fakeSocket, ctx);
    sent.length = 0;

    const result = handleRecordingPause('conv-other-pause', ctx);
    expect(result).toBe(recordingId);
  });
});

describe('handleRecordingResume', () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test('sends recording_resume for active recording', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-resume-1';
    ctx.socketToSession.set(fakeSocket, conversationId);

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const result = handleRecordingResume(conversationId, ctx);

    expect(result).toBe(recordingId);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('recording_resume');
    expect(sent[0].recordingId).toBe(recordingId);
  });

  test('returns undefined when no active recording', () => {
    const { ctx } = createCtx();

    const result = handleRecordingResume('conv-no-rec', ctx);
    expect(result).toBeUndefined();
  });
});

// ─── isRecordingIdle tests ──────────────────────────────────────────────────

describe('isRecordingIdle', () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test('returns true when no recording and no pending restart', () => {
    expect(isRecordingIdle()).toBe(true);
  });

  test('returns false when recording is active', () => {
    const { ctx, fakeSocket } = createCtx();
    handleRecordingStart('conv-idle-1', undefined, fakeSocket, ctx);
    expect(isRecordingIdle()).toBe(false);
  });

  test('returns false when mid-restart (between stop and start confirmation)', () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = 'conv-idle-restart';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    handleRecordingRestart(conversationId, fakeSocket, ctx);

    // Mid-restart: there IS an active recording (the new one) AND a pending restart
    expect(isRecordingIdle()).toBe(false);
  });

  test('returns true after restart completes', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-idle-complete';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);

    // Simulate the new recording starting
    const startMsg = sent.filter((m) => m.type === 'recording_start').pop();
    const startedStatus: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg!.recordingId as string,
      status: 'started',
      operationToken: restartResult.operationToken,
    };
    recordingHandlers.recording_status(startedStatus, fakeSocket, ctx);

    // Restart is complete, but recording is still active
    expect(getActiveRestartToken()).toBeNull();
    // Not idle because the new recording is still running
    expect(isRecordingIdle()).toBe(false);
  });
});

// ─── Recording executor integration tests ───────────────────────────────────

describe('executeRecordingIntent — restart/pause/resume', () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test('restart_only executes actual restart', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-exec-restart';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start a recording first
    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    const result = executeRecordingIntent(
      { kind: 'restart_only' },
      { conversationId, socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe('Restarting screen recording.');

    // Should have sent stop + start
    const stopMsgs = sent.filter((m) => m.type === 'recording_stop');
    const startMsgs = sent.filter((m) => m.type === 'recording_start');
    expect(stopMsgs).toHaveLength(1);
    expect(startMsgs).toHaveLength(1);
  });

  test('restart_only returns "no active recording" when idle', () => {
    const { ctx, fakeSocket } = createCtx();

    const result = executeRecordingIntent(
      { kind: 'restart_only' },
      { conversationId: 'conv-no-rec', socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe('No active recording to restart.');
  });

  test('restart_with_remainder returns deferred restart', () => {
    const { ctx, fakeSocket } = createCtx();

    const result = executeRecordingIntent(
      { kind: 'restart_with_remainder', remainder: 'do something else' },
      { conversationId: 'conv-rem', socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(false);
    expect(result.pendingRestart).toBe(true);
    expect(result.remainderText).toBe('do something else');
  });

  test('pause_only executes actual pause', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-exec-pause';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    const result = executeRecordingIntent(
      { kind: 'pause_only' },
      { conversationId, socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe('Pausing the recording.');

    const pauseMsgs = sent.filter((m) => m.type === 'recording_pause');
    expect(pauseMsgs).toHaveLength(1);
  });

  test('pause_only returns "no active recording" when idle', () => {
    const { ctx, fakeSocket } = createCtx();

    const result = executeRecordingIntent(
      { kind: 'pause_only' },
      { conversationId: 'conv-no-rec', socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe('No active recording to pause.');
  });

  test('resume_only executes actual resume', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-exec-resume';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    sent.length = 0;

    const result = executeRecordingIntent(
      { kind: 'resume_only' },
      { conversationId, socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe('Resuming the recording.');

    const resumeMsgs = sent.filter((m) => m.type === 'recording_resume');
    expect(resumeMsgs).toHaveLength(1);
  });

  test('resume_only returns "no active recording" when idle', () => {
    const { ctx, fakeSocket } = createCtx();

    const result = executeRecordingIntent(
      { kind: 'resume_only' },
      { conversationId: 'conv-no-rec', socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe('No active recording to resume.');
  });
});

// ─── Recording status paused/resumed acknowledgement tests ──────────────────

describe('recording_status paused/resumed', () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test('handles paused status without error', () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = 'conv-status-paused';

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    expect(recordingId).not.toBeNull();

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId!,
      status: 'paused',
    };

    expect(() => {
      recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);
    }).not.toThrow();
  });

  test('handles resumed status without error', () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = 'conv-status-resumed';

    const recordingId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    expect(recordingId).not.toBeNull();

    const statusMsg: RecordingStatus = {
      type: 'recording_status',
      sessionId: recordingId!,
      status: 'resumed',
    };

    expect(() => {
      recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);
    }).not.toThrow();
  });
});

// ─── Failed during restart cleans up restart state ──────────────────────────

describe('failure during restart', () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test('failed status during restart clears pending restart state', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-fail-restart';
    ctx.socketToSession.set(fakeSocket, conversationId);

    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    const restartResult = handleRecordingRestart(conversationId, fakeSocket, ctx);

    const startMsg = sent.filter((m) => m.type === 'recording_start').pop();
    sent.length = 0;

    // Simulate new recording failing (with the correct operation token)
    const failedStatus: RecordingStatus = {
      type: 'recording_status',
      sessionId: startMsg!.recordingId as string,
      status: 'failed',
      error: 'Permission denied',
      attachToConversationId: conversationId,
      operationToken: restartResult.operationToken,
    };
    recordingHandlers.recording_status(failedStatus, fakeSocket, ctx);

    // Restart state should be cleaned up
    expect(getActiveRestartToken()).toBeNull();
    expect(isRecordingIdle()).toBe(true);
  });
});

// ─── start_and_stop_only from idle state ─────────────────────────────────────

describe('start_and_stop_only fallback to plain start when idle', () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test('falls back to handleRecordingStart when no active recording', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-stop-start-idle';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // No recording is active — start_and_stop_only should fall back to a
    // plain start rather than returning "No active recording to restart."
    const result = executeRecordingIntent(
      { kind: 'start_and_stop_only' },
      { conversationId, socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.recordingStarted).toBe(true);
    expect(result.responseText).toBe('Starting screen recording.');

    // Should have sent only a recording_start (no stop since nothing was active)
    const stopMsgs = sent.filter((m) => m.type === 'recording_stop');
    const startMsgs = sent.filter((m) => m.type === 'recording_start');
    expect(stopMsgs).toHaveLength(0);
    expect(startMsgs).toHaveLength(1);
  });

  test('goes through restart when a recording is active', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = 'conv-stop-start-active';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start a recording first
    const originalId = handleRecordingStart(conversationId, undefined, fakeSocket, ctx);
    expect(originalId).not.toBeNull();
    sent.length = 0;

    // Now start_and_stop_only should go through handleRecordingRestart
    const result = executeRecordingIntent(
      { kind: 'start_and_stop_only' },
      { conversationId, socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.recordingStarted).toBe(true);
    expect(result.responseText).toBe('Stopping current recording and starting a new one.');

    // Should have sent both stop and start (restart flow)
    const stopMsgs = sent.filter((m) => m.type === 'recording_stop');
    const startMsgs = sent.filter((m) => m.type === 'recording_start');
    expect(stopMsgs).toHaveLength(1);
    expect(startMsgs).toHaveLength(1);
  });
});

// ─── start_and_stop_with_remainder from idle state ───────────────────────────

describe('start_and_stop_with_remainder fallback to plain start when idle', () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test('sets pendingStart (not pendingRestart) when no active recording', () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = 'conv-rem-idle';

    const result = executeRecordingIntent(
      { kind: 'start_and_stop_with_remainder', remainder: 'do something' },
      { conversationId, socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(false);
    expect(result.pendingStart).toBe(true);
    expect(result.pendingRestart).toBeUndefined();
    expect(result.remainderText).toBe('do something');
  });

  test('sets pendingRestart when a recording is active', () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = 'conv-rem-active';
    ctx.socketToSession.set(fakeSocket, conversationId);

    // Start a recording first
    handleRecordingStart(conversationId, undefined, fakeSocket, ctx);

    const result = executeRecordingIntent(
      { kind: 'start_and_stop_with_remainder', remainder: 'do something' },
      { conversationId, socket: fakeSocket, ctx },
    );

    expect(result.handled).toBe(false);
    expect(result.pendingRestart).toBe(true);
    expect(result.pendingStart).toBeUndefined();
    expect(result.remainderText).toBe('do something');
  });
});

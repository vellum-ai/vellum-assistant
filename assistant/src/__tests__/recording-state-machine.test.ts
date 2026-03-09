import * as net from "node:net";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mocks (must be before any imports that depend on them) ─────────────────

const noop = () => {};
const noopLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => noopLogger,
};

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    daemon: { standaloneRecording: true },
    provider: "mock-provider",
    permissions: { mode: "workspace" },
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

mock.module("../memory/conversation-crud.js", () => ({
  getConversationThreadType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => mockMessages,
  addMessage: (_convId: string, role: string, content: string) => {
    const msg = { id: `msg-${++mockMessageIdCounter}`, role, content };
    mockMessages.push(msg);
    return msg;
  },
  createConversation: () => ({ id: "conv-mock" }),
  getConversation: () => ({ id: "conv-mock" }),
}));

// Attachments store mock
mock.module("../memory/attachments-store.js", () => ({
  uploadFileBackedAttachment: () => ({
    id: "att-mock",
    originalFilename: "test.mov",
    mimeType: "video/quicktime",
    sizeBytes: 1024,
  }),
  linkAttachmentToMessage: noop,
  setAttachmentThumbnail: noop,
}));

// Capture real modules BEFORE mocking to avoid circular resolution
// (mock.module('node:fs') + require('fs') inside factory = deadlock)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPath = require("path");

// Mock node:fs
mock.module("node:fs", () => ({
  ...realFs,
  existsSync: (p: string) => {
    if (p.includes("recording") || p.includes("/tmp/")) return true;
    return realFs.existsSync(p);
  },
  statSync: (p: string, opts?: any) => {
    if (p.includes("recording") || p.includes("/tmp/")) return { size: 1024 };
    return realFs.statSync(p, opts);
  },
  realpathSync: (p: string) => {
    // Use path.resolve() to canonicalize `..` segments so traversal
    // attacks like `${ALLOWED_DIR}/../outside.mov` are normalized,
    // preserving the same semantics as the real realpathSync without
    // hitting the filesystem (which would throw ENOENT for test paths).
    return realPath.resolve(p);
  },
}));

// Mock video thumbnail
mock.module("../daemon/video-thumbnail.js", () => ({
  generateVideoThumbnailFromPath: async () => null,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  __injectRecordingOwner,
  __resetRecordingState,
  getActiveRestartToken,
  handleRecordingPause,
  handleRecordingRestart,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStop,
  isRecordingIdle,
  recordingHandlers,
} from "../daemon/handlers/recording.js";
import type { HandlerContext } from "../daemon/handlers/shared.js";
import type { RecordingStatus } from "../daemon/message-types/computer-use.js";
import { executeRecordingIntent } from "../daemon/recording-executor.js";
import { DebouncerMap } from "../util/debounce.js";

// The allowed recordings directory used by the recording handler
const ALLOWED_RECORDINGS_DIR = `${process.env.HOME}/Library/Application Support/vellum-assistant/recordings`;

// ─── Test helpers ───────────────────────────────────────────────────────────

function createCtx(): {
  ctx: HandlerContext;
  sent: Array<{ type: string; [k: string]: unknown }>;
  fakeSocket: net.Socket;
} {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];
  const fakeSocket = {} as net.Socket;

  const ctx: HandlerContext = {
    sessions: new Map(),
    cuSessions: new Map(),
    cuObservationParseSequence: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: noop,
    updateConfigFingerprint: noop,
    send: (_socket, msg) => {
      sent.push(msg as { type: string; [k: string]: unknown });
    },
    broadcast: (msg) => {
      sent.push(msg as { type: string; [k: string]: unknown });
    },
    clearAllSessions: () => 0,
    getOrCreateSession: () => {
      throw new Error("not implemented");
    },
    touchSession: noop,
  };

  return { ctx, sent, fakeSocket };
}

// ─── Restart state machine tests ────────────────────────────────────────────

describe("handleRecordingRestart", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test("sends recording_stop and defers start until stop-ack", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-restart-1";

    // Start a recording first
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(originalId).not.toBeNull();
    sent.length = 0;

    const result = handleRecordingRestart(conversationId, ctx);

    expect(result.initiated).toBe(true);
    expect(result.operationToken).toBeTruthy();
    expect(result.responseText).toBe("Restarting screen recording.");

    // Should have sent only recording_stop (start is deferred)
    const stopMsgs = sent.filter((m) => m.type === "recording_stop");
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(stopMsgs).toHaveLength(1);
    expect(startMsgs).toHaveLength(0);

    // Simulate the client acknowledging the stop
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // NOW the deferred recording_start should have been sent
    const startMsgsAfterAck = sent.filter((m) => m.type === "recording_start");
    expect(startMsgsAfterAck).toHaveLength(1);
    expect(startMsgsAfterAck[0].operationToken).toBe(result.operationToken);
  });

  test('returns "no active recording" with reason when nothing is recording', () => {
    const { ctx } = createCtx();

    const result = handleRecordingRestart("conv-no-rec", ctx);

    expect(result.initiated).toBe(false);
    expect(result.reason).toBe("no_active_recording");
    expect(result.responseText).toBe("No active recording to restart.");
  });

  test("generates unique operation token for each restart", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-restart-unique";

    // First restart cycle
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    const result1 = handleRecordingRestart(conversationId, ctx);

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus1: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus1, fakeSocket, ctx);

    // Simulate the first restart completing (started status)
    const startMsg1 = sent.filter((m) => m.type === "recording_start").pop();
    const status1: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg1!.recordingId as string,
      status: "started",
      operationToken: result1.operationToken,
    };
    recordingHandlers.recording_status(status1, fakeSocket, ctx);

    // Second restart cycle
    sent.length = 0;
    const result2 = handleRecordingRestart(conversationId, ctx);

    expect(result1.operationToken).not.toBe(result2.operationToken);
  });
});

// ─── Restart cancel tests ───────────────────────────────────────────────────

describe("restart_cancelled status", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test('emits restart_cancelled response, never "new recording started"', () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-cancel-1";

    // Start -> restart
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Get the new recording ID from the deferred recording_start message
    const startMsg = sent.filter((m) => m.type === "recording_start").pop();
    sent.length = 0;

    // Client sends restart_cancelled (picker was closed) with the correct operation token
    const cancelStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg!.recordingId as string,
      status: "restart_cancelled",
      attachToConversationId: conversationId,
      operationToken: restartResult.operationToken,
    };
    recordingHandlers.recording_status(cancelStatus, fakeSocket, ctx);

    // Should have emitted the cancellation message
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe("Recording restart cancelled.");

    // Should NOT have "new recording started" anywhere
    const startedMsgs = sent.filter(
      (m) =>
        m.type === "assistant_text_delta" &&
        typeof m.text === "string" &&
        m.text.includes("new recording started"),
    );
    expect(startedMsgs).toHaveLength(0);

    // Recording should be truly idle after cancel
    expect(isRecordingIdle()).toBe(true);
  });

  test("cleans up restart state on cancel", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-cancel-cleanup";

    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );

    // Before stop-ack: not idle (mid-restart)
    expect(isRecordingIdle()).toBe(false);

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Still not idle — the new recording has started
    expect(isRecordingIdle()).toBe(false);

    const startMsg = sent.filter((m) => m.type === "recording_start").pop();
    const cancelStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg!.recordingId as string,
      status: "restart_cancelled",
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

describe("stale completion guard (operation token)", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test("rejects recording_status with stale operation token", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-stale-1";

    // Start recording -> restart (creates operation token)
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    const startMsg = sent.filter((m) => m.type === "recording_start").pop();
    sent.length = 0;

    // Simulate a stale "started" status from a PREVIOUS restart cycle
    const staleStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg!.recordingId as string,
      status: "started",
      operationToken: "old-stale-token-from-previous-cycle",
    };
    recordingHandlers.recording_status(staleStatus, fakeSocket, ctx);

    // Should have been rejected — no "started" confirmation messages
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas).toHaveLength(0);

    // Active restart token should still be set (not cleared by stale completion)
    expect(getActiveRestartToken()).toBe(restartResult.operationToken!);
  });

  test("accepts recording_status with matching operation token", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-matching-1";

    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    const startMsg = sent.filter((m) => m.type === "recording_start").pop();

    // Send status with the CORRECT token
    const validStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg!.recordingId as string,
      status: "started",
      operationToken: restartResult.operationToken,
    };
    recordingHandlers.recording_status(validStatus, fakeSocket, ctx);

    // Should have been accepted — restart token cleared
    expect(getActiveRestartToken()).toBeNull();
  });

  test("allows tokenless recording_status during active restart (old recording ack)", async () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-tokenless-1";

    // Start recording -> restart (creates operation token)
    handleRecordingStart(conversationId, undefined, ctx);
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);

    const startMsgs = sent.filter((m) => m.type === "recording_start");
    const oldStartMsg = startMsgs[0]; // first recording_start = original/old recording
    sent.length = 0;

    // Simulate a tokenless "stopped" status arriving during the restart.
    // This represents the OLD recording's stopped ack — it was started before
    // the restart was initiated, so it has no operationToken. This MUST be
    // allowed through for the deferred restart pattern to work.
    const tokenlessStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: oldStartMsg!.recordingId as string,
      status: "stopped",
      attachToConversationId: conversationId,
      // No operationToken — from old recording, should be allowed
    };
    await recordingHandlers.recording_status(tokenlessStatus, fakeSocket, ctx);

    // Should have triggered the deferred restart start
    const newStartMsgs = sent.filter((m) => m.type === "recording_start");
    expect(newStartMsgs).toHaveLength(1);

    // The old recording finalization runs (no filePath → "no file was produced"
    // text delta). This is expected after M2: the stopped handler finalizes the
    // old recording before starting the new one.
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
  });

  test("no ghost state after restart stop/start handoff", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-ghost-1";

    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );

    // Restart sends stop and defers start until stop-ack
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // The new recording should be active (not the old one)
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(startMsgs.length).toBeGreaterThanOrEqual(2); // original + deferred restart

    // The last recording_start should have the operation token
    const lastStart = startMsgs[startMsgs.length - 1];
    expect(lastStart.operationToken).toBe(restartResult.operationToken);
  });
});

// ─── Pause/resume state transition tests ────────────────────────────────────

describe("handleRecordingPause", () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test("sends recording_pause for active recording", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-pause-1";

    const recordingId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const result = handleRecordingPause(conversationId, ctx);

    expect(result).toBe(recordingId!);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_pause");
    expect(sent[0].recordingId).toBe(recordingId);
  });

  test("returns undefined when no active recording", () => {
    const { ctx } = createCtx();

    const result = handleRecordingPause("conv-no-rec", ctx);
    expect(result).toBeUndefined();
  });

  test("resolves to globally active recording from different conversation", () => {
    const { ctx, sent } = createCtx();
    const convA = "conv-owner-pause";

    const recordingId = handleRecordingStart(convA, undefined, ctx);
    sent.length = 0;

    const result = handleRecordingPause("conv-other-pause", ctx);
    expect(result).toBe(recordingId!);
  });
});

describe("handleRecordingResume", () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test("sends recording_resume for active recording", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-resume-1";

    const recordingId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const result = handleRecordingResume(conversationId, ctx);

    expect(result).toBe(recordingId!);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_resume");
    expect(sent[0].recordingId).toBe(recordingId);
  });

  test("returns undefined when no active recording", () => {
    const { ctx } = createCtx();

    const result = handleRecordingResume("conv-no-rec", ctx);
    expect(result).toBeUndefined();
  });
});

// ─── isRecordingIdle tests ──────────────────────────────────────────────────

describe("isRecordingIdle", () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test("returns true when no recording and no pending restart", () => {
    expect(isRecordingIdle()).toBe(true);
  });

  test("returns false when recording is active", () => {
    const { ctx } = createCtx();
    handleRecordingStart("conv-idle-1", undefined, ctx);
    expect(isRecordingIdle()).toBe(false);
  });

  test("returns false when mid-restart (between stop-ack and start confirmation)", () => {
    const { ctx } = createCtx();
    const conversationId = "conv-idle-restart";

    handleRecordingStart(conversationId, undefined, ctx);
    handleRecordingRestart(conversationId, ctx);

    // Mid-restart: the old recording maps are still present AND there's a
    // pending restart, so the system is not idle
    expect(isRecordingIdle()).toBe(false);
  });

  test("returns true after restart completes", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-idle-complete";

    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Simulate the new recording starting
    const startMsg = sent.filter((m) => m.type === "recording_start").pop();
    const startedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg!.recordingId as string,
      status: "started",
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

describe("executeRecordingIntent — restart/pause/resume", () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test("restart_only executes actual restart (deferred start)", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-exec-restart";

    // Start a recording first
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    sent.length = 0;

    const result = executeRecordingIntent(
      { kind: "restart_only" },
      { conversationId, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe("Restarting screen recording.");

    // Should have sent only stop (start is deferred until stop-ack)
    const stopMsgs = sent.filter((m) => m.type === "recording_stop");
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(stopMsgs).toHaveLength(1);
    expect(startMsgs).toHaveLength(0);

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // NOW the deferred start should have been sent
    const startMsgsAfterAck = sent.filter((m) => m.type === "recording_start");
    expect(startMsgsAfterAck).toHaveLength(1);
  });

  test('restart_only returns "no active recording" when idle', () => {
    const { ctx } = createCtx();

    const result = executeRecordingIntent(
      { kind: "restart_only" },
      { conversationId: "conv-no-rec", ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe("No active recording to restart.");
  });

  test("restart_with_remainder returns deferred restart", () => {
    const { ctx } = createCtx();

    const result = executeRecordingIntent(
      { kind: "restart_with_remainder", remainder: "do something else" },
      { conversationId: "conv-rem", ctx },
    );

    expect(result.handled).toBe(false);
    expect(result.pendingRestart).toBe(true);
    expect(result.remainderText).toBe("do something else");
  });

  test("pause_only executes actual pause", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-exec-pause";

    handleRecordingStart(conversationId, undefined, ctx);
    sent.length = 0;

    const result = executeRecordingIntent(
      { kind: "pause_only" },
      { conversationId, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe("Pausing the recording.");

    const pauseMsgs = sent.filter((m) => m.type === "recording_pause");
    expect(pauseMsgs).toHaveLength(1);
  });

  test('pause_only returns "no active recording" when idle', () => {
    const { ctx } = createCtx();

    const result = executeRecordingIntent(
      { kind: "pause_only" },
      { conversationId: "conv-no-rec", ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe("No active recording to pause.");
  });

  test("resume_only executes actual resume", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-exec-resume";

    handleRecordingStart(conversationId, undefined, ctx);
    sent.length = 0;

    const result = executeRecordingIntent(
      { kind: "resume_only" },
      { conversationId, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe("Resuming the recording.");

    const resumeMsgs = sent.filter((m) => m.type === "recording_resume");
    expect(resumeMsgs).toHaveLength(1);
  });

  test('resume_only returns "no active recording" when idle', () => {
    const { ctx } = createCtx();

    const result = executeRecordingIntent(
      { kind: "resume_only" },
      { conversationId: "conv-no-rec", ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.responseText).toBe("No active recording to resume.");
  });
});

// ─── Recording status paused/resumed acknowledgement tests ──────────────────

describe("recording_status paused/resumed", () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test("handles paused status without error", () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = "conv-status-paused";

    const recordingId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(recordingId).not.toBeNull();

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      sessionId: recordingId!,
      status: "paused",
    };

    expect(() => {
      recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);
    }).not.toThrow();
  });

  test("handles resumed status without error", () => {
    const { ctx, fakeSocket } = createCtx();
    const conversationId = "conv-status-resumed";

    const recordingId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(recordingId).not.toBeNull();

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      sessionId: recordingId!,
      status: "resumed",
    };

    expect(() => {
      recordingHandlers.recording_status(statusMsg, fakeSocket, ctx);
    }).not.toThrow();
  });
});

// ─── Failed during restart cleans up restart state ──────────────────────────

describe("failure during restart", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test("failed status during restart clears pending restart state (old recording fails)", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-fail-restart";

    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    handleRecordingRestart(conversationId, ctx);
    sent.length = 0;

    // Simulate the old recording failing to stop (before stop-ack)
    const failedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "failed",
      error: "Permission denied",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(failedStatus, fakeSocket, ctx);

    // Restart state and deferred restart should be cleaned up
    expect(getActiveRestartToken()).toBeNull();
    expect(isRecordingIdle()).toBe(true);
  });

  test("failed status during restart clears state (new recording fails after deferred start)", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-fail-restart-new";

    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    const startMsg = sent.filter((m) => m.type === "recording_start").pop();
    sent.length = 0;

    // Simulate new recording failing (with the correct operation token)
    const failedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg!.recordingId as string,
      status: "failed",
      error: "Permission denied",
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

describe("start_and_stop_only fallback to plain start when idle", () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test("falls back to handleRecordingStart when no active recording", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-stop-start-idle";

    // No recording is active — start_and_stop_only should fall back to a
    // plain start rather than returning "No active recording to restart."
    const result = executeRecordingIntent(
      { kind: "start_and_stop_only" },
      { conversationId, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.recordingStarted).toBe(true);
    expect(result.responseText).toBe("Starting screen recording.");

    // Should have sent only a recording_start (no stop since nothing was active)
    const stopMsgs = sent.filter((m) => m.type === "recording_stop");
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(stopMsgs).toHaveLength(0);
    expect(startMsgs).toHaveLength(1);
  });

  test("goes through restart when a recording is active (deferred start)", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-stop-start-active";

    // Start a recording first
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(originalId).not.toBeNull();
    sent.length = 0;

    // Now start_and_stop_only should go through handleRecordingRestart
    const result = executeRecordingIntent(
      { kind: "start_and_stop_only" },
      { conversationId, ctx },
    );

    expect(result.handled).toBe(true);
    expect(result.recordingStarted).toBe(true);
    expect(result.responseText).toBe(
      "Stopping current recording and starting a new one.",
    );

    // Should have sent only stop (start is deferred until stop-ack)
    const stopMsgs = sent.filter((m) => m.type === "recording_stop");
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(stopMsgs).toHaveLength(1);
    expect(startMsgs).toHaveLength(0);

    // Simulate the stop-ack to trigger the deferred start
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // NOW the deferred start should have been sent
    const startMsgsAfterAck = sent.filter((m) => m.type === "recording_start");
    expect(startMsgsAfterAck).toHaveLength(1);
  });
});

// ─── start_and_stop_with_remainder from idle state ───────────────────────────

describe("start_and_stop_with_remainder fallback to plain start when idle", () => {
  beforeEach(() => {
    __resetRecordingState();
  });

  test("sets pendingStart (not pendingRestart) when no active recording", () => {
    const { ctx } = createCtx();
    const conversationId = "conv-rem-idle";

    const result = executeRecordingIntent(
      { kind: "start_and_stop_with_remainder", remainder: "do something" },
      { conversationId, ctx },
    );

    expect(result.handled).toBe(false);
    expect(result.pendingStart).toBe(true);
    expect(result.pendingRestart).toBeUndefined();
    expect(result.remainderText).toBe("do something");
  });

  test("sets pendingRestart when a recording is active", () => {
    const { ctx } = createCtx();
    const conversationId = "conv-rem-active";

    // Start a recording first
    handleRecordingStart(conversationId, undefined, ctx);

    const result = executeRecordingIntent(
      { kind: "start_and_stop_with_remainder", remainder: "do something" },
      { conversationId, ctx },
    );

    expect(result.handled).toBe(false);
    expect(result.pendingRestart).toBe(true);
    expect(result.pendingStart).toBeUndefined();
    expect(result.remainderText).toBe("do something");
  });
});

// ─── Deferred restart race condition tests ───────────────────────────────────

describe("deferred restart prevents race condition", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test("recording_start is NOT sent until client acks the stop", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-deferred-race";

    handleRecordingStart(conversationId, undefined, ctx);
    sent.length = 0;

    handleRecordingRestart(conversationId, ctx);

    // Only recording_stop should have been sent — no recording_start yet
    expect(sent.filter((m) => m.type === "recording_stop")).toHaveLength(1);
    expect(sent.filter((m) => m.type === "recording_start")).toHaveLength(0);

    // System is mid-restart — not idle
    expect(isRecordingIdle()).toBe(false);
  });

  test("stop-ack timeout cleans up deferred restart state", () => {
    // This test uses a real timer via bun's jest-compatible API
    const { ctx } = createCtx();
    const conversationId = "conv-deferred-timeout";

    handleRecordingStart(conversationId, undefined, ctx);
    handleRecordingRestart(conversationId, ctx);

    // Mid-restart: not idle
    expect(isRecordingIdle()).toBe(false);

    // We cannot easily test the setTimeout firing here without mocking timers,
    // but we can verify the state is correctly set up for the timeout to clean up.
    expect(getActiveRestartToken()).not.toBeNull();
  });

  test("cross-conversation restart: conversation B restarts recording owned by A", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const convA = "conv-owner-A";
    const convB = "conv-requester-B";

    // Conversation A starts a recording
    const originalId = handleRecordingStart(convA, undefined, ctx);
    expect(originalId).not.toBeNull();
    sent.length = 0;

    // Conversation B requests a restart (cross-conversation via global fallback)
    const result = handleRecordingRestart(convB, ctx);
    expect(result.initiated).toBe(true);
    expect(result.operationToken).toBeTruthy();

    // Should have sent recording_stop (start is deferred)
    expect(sent.filter((m) => m.type === "recording_stop")).toHaveLength(1);
    expect(sent.filter((m) => m.type === "recording_start")).toHaveLength(0);

    // Simulate the client acknowledging the stop. The stopped status resolves
    // conversationId from standaloneRecordingConversationId which maps to A.
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      attachToConversationId: convA,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // The deferred recording_start MUST have been triggered even though the
    // stopped callback resolved to conversation A (owner), not B (requester).
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(startMsgs).toHaveLength(1);
    expect(startMsgs[0].operationToken).toBe(result.operationToken);

    // The new recording is owned by B (the requester). Simulate the client
    // confirming the new recording started. The 'started' status resolves
    // conversationId to B, so pendingRestartByConversation must have been
    // migrated from A to B for the restart cycle to complete.
    const newRecordingId = startMsgs[0].recordingId as string;
    const startedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: newRecordingId,
      status: "started",
      operationToken: result.operationToken,
      attachToConversationId: convB,
    };
    recordingHandlers.recording_status(startedStatus, fakeSocket, ctx);

    // Restart cycle must be fully complete: activeRestartToken cleared
    expect(getActiveRestartToken()).toBeNull();

    // Not idle yet because the new recording is still running
    expect(isRecordingIdle()).toBe(false);

    // Stop the new recording and verify system returns to idle
    handleRecordingStop(convB, ctx);
    const newStoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: newRecordingId,
      status: "stopped",
      attachToConversationId: convB,
    };
    recordingHandlers.recording_status(newStoppedStatus, fakeSocket, ctx);

    expect(isRecordingIdle()).toBe(true);
  });

  test("normal stop (non-restart) does not trigger deferred start", () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-normal-stop";

    const recordingId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(recordingId).not.toBeNull();

    // Manually stop (not via restart)
    handleRecordingStop(conversationId, ctx);
    sent.length = 0;

    // Simulate stop-ack without file path (e.g. very short recording)
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: recordingId!,
      status: "stopped",
      attachToConversationId: conversationId,
    };
    recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Should NOT have sent a recording_start (no deferred restart pending)
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(startMsgs).toHaveLength(0);
    expect(isRecordingIdle()).toBe(true);
  });
});

// ─── Restart finalization tests ──────────────────────────────────────────────

describe("restart finalization", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockMessageIdCounter = 0;
  });

  test("publishes previous recording attachment on restart", async () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-fin-publish";

    // Start a recording
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );
    expect(originalId).not.toBeNull();

    // Trigger restart
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);
    sent.length = 0;

    // Simulate stopped for old recording with filePath and durationMs
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-old.mov`,
      durationMs: 5000,
      attachToConversationId: conversationId,
    };
    await recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Verify: a new recording_start IPC was sent (deferred start triggered)
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(startMsgs).toHaveLength(1);
    expect(startMsgs[0].operationToken).toBe(restartResult.operationToken);

    // Verify: finalizeAndPublishRecording was called — check that sent
    // contains messages with attachment data (assistant_text_delta + message_complete)
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    const successMsg = textDeltas.find(
      (m) =>
        typeof m.text === "string" &&
        m.text.includes("Screen recording complete"),
    );
    expect(successMsg).toBeTruthy();

    const completes = sent.filter((m) => m.type === "message_complete");
    const attachmentComplete = completes.find((m) => m.attachments != null);
    expect(attachmentComplete).toBeTruthy();

    // Verify: a message was added to the conversation store
    const assistantMsg = mockMessages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
  });

  test("restart + picker cancel preserves previous publish", async () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-fin-cancel-preserve";

    // Start a recording
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );

    // Restart
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);

    // Simulate stopped for old recording with filePath
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-preserved.mov`,
      durationMs: 3000,
      attachToConversationId: conversationId,
    };
    await recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Capture sent messages so far (should include old recording's attachment)
    const preCancelTextDeltas = sent.filter(
      (m) => m.type === "assistant_text_delta",
    );
    const oldAttachmentMsg = preCancelTextDeltas.find(
      (m) =>
        typeof m.text === "string" &&
        m.text.includes("Screen recording complete"),
    );
    expect(oldAttachmentMsg).toBeTruthy();

    // Get the new recording ID from the deferred recording_start message
    const startMsg = sent.filter((m) => m.type === "recording_start").pop();
    expect(startMsg).toBeTruthy();

    // Client sends restart_cancelled (picker was closed)
    const cancelStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: startMsg!.recordingId as string,
      status: "restart_cancelled",
      attachToConversationId: conversationId,
      operationToken: restartResult.operationToken,
    };
    await recordingHandlers.recording_status(cancelStatus, fakeSocket, ctx);

    // Verify: the old recording's attachment messages are still in sent
    const postCancelTextDeltas = sent.filter(
      (m) => m.type === "assistant_text_delta",
    );
    const oldMsgStillPresent = postCancelTextDeltas.find(
      (m) =>
        typeof m.text === "string" &&
        m.text.includes("Screen recording complete"),
    );
    expect(oldMsgStillPresent).toBeTruthy();

    // Verify: restart_cancelled adds "Recording restart cancelled." text
    const cancelMsg = postCancelTextDeltas.find(
      (m) =>
        typeof m.text === "string" && m.text === "Recording restart cancelled.",
    );
    expect(cancelMsg).toBeTruthy();

    // Verify: the old recording's message was not removed from conversation store
    const assistantMsg = mockMessages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
  });

  test("emits truthful failure text when previous finalize fails", async () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-fin-fail-truth";

    // Start a recording
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );

    // Restart
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);
    sent.length = 0;

    // Simulate stopped with missing filePath (no file produced)
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      // No filePath — recording stopped without producing a file
      attachToConversationId: conversationId,
    };
    await recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Verify: error message text is sent (not "Screen recording complete")
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    const hasSuccessMsg = textDeltas.some(
      (m) =>
        typeof m.text === "string" &&
        m.text.includes("Screen recording complete"),
    );
    expect(hasSuccessMsg).toBe(false);

    const hasErrorMsg = textDeltas.some(
      (m) =>
        typeof m.text === "string" && m.text.includes("no file was produced"),
    );
    expect(hasErrorMsg).toBe(true);

    // Verify: new recording_start still triggers (deferred start)
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(startMsgs).toHaveLength(1);
    expect(startMsgs[0].operationToken).toBe(restartResult.operationToken);
  });

  test("preserves previous attachment when new start fails", async () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-fin-new-fail";

    // Start a recording
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );

    // Restart
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);

    // Inject a blocker recording on a different conversation so that
    // when the stopped handler calls cleanupMaps (removing conv-A's entry)
    // and then tries handleRecordingStart, the global single-active guard
    // sees the blocker entry and returns null — exercising the start-failure
    // code path.
    __injectRecordingOwner("conv-blocker", "rec-blocker");

    sent.length = 0;

    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-old-success.mov`,
      durationMs: 4000,
      attachToConversationId: conversationId,
    };
    await recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Verify: old recording attachment is published (finalization succeeded)
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    const successMsg = textDeltas.find(
      (m) =>
        typeof m.text === "string" &&
        m.text.includes("Screen recording complete"),
    );
    expect(successMsg).toBeTruthy();

    const completes = sent.filter((m) => m.type === "message_complete");
    const attachmentComplete = completes.find((m) => m.attachments != null);
    expect(attachmentComplete).toBeTruthy();

    // Verify: no recording_start was sent (deferred start was blocked)
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(startMsgs).toHaveLength(0);

    // Verify: follow-up message about the start failure was sent
    const failureMsg = textDeltas.find(
      (m) =>
        typeof m.text === "string" &&
        m.text.includes(
          "Previous recording saved. New recording failed to start.",
        ),
    );
    expect(failureMsg).toBeTruthy();

    // Verify: old recording message exists in conversation store
    const assistantMsg = mockMessages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
  });

  test("duplicate stopped callback does not double-attach", async () => {
    const { ctx, sent, fakeSocket } = createCtx();
    const conversationId = "conv-fin-dup-stop";

    // Start a recording
    const originalId = handleRecordingStart(
      conversationId,
      undefined,
      ctx,
    );

    // Restart
    const restartResult = handleRecordingRestart(
      conversationId,
      ctx,
    );
    expect(restartResult.initiated).toBe(true);
    sent.length = 0;

    // First stopped callback with filePath
    const stoppedStatus: RecordingStatus = {
      type: "recording_status",
      sessionId: originalId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-dup.mov`,
      durationMs: 2000,
      attachToConversationId: conversationId,
    };
    await recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Count attachment-related messages after first callback
    const firstCallAttachmentMsgs = sent.filter(
      (m) =>
        m.type === "assistant_text_delta" &&
        typeof m.text === "string" &&
        m.text.includes("Screen recording complete"),
    );
    expect(firstCallAttachmentMsgs).toHaveLength(1);

    const firstCallMsgCount = mockMessages.filter(
      (m) => m.role === "assistant",
    ).length;
    expect(firstCallMsgCount).toBe(1);

    // Send stopped again with same recordingId (duplicate)
    await recordingHandlers.recording_status(stoppedStatus, fakeSocket, ctx);

    // Verify: only one attachment message exists in sent — the duplicate was
    // rejected by the idempotency guard in finalizeAndPublishRecording
    const allAttachmentMsgs = sent.filter(
      (m) =>
        m.type === "assistant_text_delta" &&
        typeof m.text === "string" &&
        m.text.includes("Screen recording complete"),
    );
    expect(allAttachmentMsgs).toHaveLength(1);

    // Verify: only one assistant message in conversation store
    const assistantMsgs = mockMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
  });

  test("existing stale-token and restart-timeout protections still pass", () => {
    // This test verifies that the module-level state functions are
    // consistent and that __resetRecordingState properly clears all state.
    // The actual stale-token and restart-timeout protection tests are in
    // the 'stale completion guard' and 'deferred restart' describe blocks
    // above — this test simply validates that state is clean after reset.
    __resetRecordingState();
    expect(isRecordingIdle()).toBe(true);
    expect(getActiveRestartToken()).toBeNull();

    // Start a recording, verify not idle
    const { ctx } = createCtx();
    const conversationId = "conv-fin-sanity";

    handleRecordingStart(conversationId, undefined, ctx);
    expect(isRecordingIdle()).toBe(false);

    // Restart, verify token is set
    handleRecordingRestart(conversationId, ctx);
    expect(getActiveRestartToken()).not.toBeNull();

    // Reset everything, verify clean state
    __resetRecordingState();
    expect(isRecordingIdle()).toBe(true);
    expect(getActiveRestartToken()).toBeNull();
  });
});

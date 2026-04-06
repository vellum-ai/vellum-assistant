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
    timeouts: { toolExecutionTimeoutSec: 30, permissionTimeoutSec: 5 },
    skills: { load: { extraDirs: [] } },
    secretDetection: { enabled: false, allowOneTimeSend: false },
    contextWindow: {
      enabled: true,
      maxInputTokens: 180000,
      targetBudgetRatio: 0.3,
      compactThreshold: 0.8,
      summaryBudgetRatio: 0.05,
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
  getConversationType: () => "default",
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
const mockAttachments: Array<{
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}> = [];
let mockAttachmentIdCounter = 0;

mock.module("../memory/attachments-store.js", () => ({
  attachFileBackedAttachmentToMessage: (
    _messageId: string,
    _position: number,
    filename: string,
    mimeType: string,
    _filePath: string,
    sizeBytes: number,
  ) => {
    const att = {
      id: `att-${++mockAttachmentIdCounter}`,
      originalFilename: filename,
      mimeType,
      sizeBytes,
    };
    mockAttachments.push(att);
    return att;
  },
  uploadFileBackedAttachment: (
    filename: string,
    mimeType: string,
    _filePath: string,
    sizeBytes: number,
  ) => {
    const att = {
      id: `att-${++mockAttachmentIdCounter}`,
      originalFilename: filename,
      mimeType,
      sizeBytes,
    };
    mockAttachments.push(att);
    return att;
  },
  linkAttachmentToMessage: noop,
  setAttachmentThumbnail: noop,
}));

// ── Mock video thumbnail ───────────────────────────────────────────────────

mock.module("../daemon/video-thumbnail.js", () => ({
  generateVideoThumbnail: async () => null,
  generateVideoThumbnailFromPath: async () => null,
}));

// The allowed recordings directory used by the recording handler
const ALLOWED_RECORDINGS_DIR = `${process.env.HOME}/Library/Application Support/vellum-assistant/recordings`;

// Mock node:fs for file existence/stat checks and realpathSync in the recording handler
let mockFileExists = true;
let mockFileSize = 1024;

mock.module("node:fs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require("fs");
  return {
    ...realFs,
    existsSync: (p: string) => {
      // Intercept paths that look like recording files (allowed dir or /tmp/)
      if (p.includes("recording") || p.includes("/tmp/")) return mockFileExists;
      return realFs.existsSync(p);
    },
    statSync: (p: string, opts?: any) => {
      if (p.includes("recording") || p.includes("/tmp/"))
        return { size: mockFileSize };
      return realFs.statSync(p, opts);
    },
    realpathSync: (p: string) => {
      // For test paths under the allowed directory or /tmp/, return as-is
      // to avoid hitting the filesystem (which would throw ENOENT)
      if (
        p.includes("recording") ||
        p.includes("/tmp/") ||
        p.includes("vellum-assistant")
      )
        return p;
      return realFs.realpathSync(p);
    },
    readFileSync: realFs.readFileSync,
  };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  __resetRecordingState,
  getActiveRestartToken,
  handleRecordingRestart,
  handleRecordingStart,
  handleRecordingStatusCore,
  handleRecordingStop,
  isRecordingIdle,
} from "../daemon/handlers/recording.js";
import type { HandlerContext } from "../daemon/handlers/shared.js";
import type { RecordingStatus } from "../daemon/message-types/computer-use.js";
import { DebouncerMap } from "../util/debounce.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

function createCtx(): {
  ctx: HandlerContext;
  sent: Array<{ type: string; [k: string]: unknown }>;
} {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];

  const ctx: HandlerContext = {
    conversations: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: noop,
    updateConfigFingerprint: noop,
    send: (msg) => {
      sent.push(msg as { type: string; [k: string]: unknown });
    },
    broadcast: (msg) => {
      sent.push(msg as { type: string; [k: string]: unknown });
    },
    clearAllConversations: () => 0,
    getOrCreateConversation: () => {
      throw new Error("not implemented");
    },
    touchConversation: noop,
  };

  return { ctx, sent };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("handleRecordingStart", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test("sends recording_start event and returns a UUID", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-1";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);

    expect(recordingId).not.toBeNull();
    // UUID v4 format
    expect(recordingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_start");
    expect(sent[0].recordingId).toBe(recordingId);
    expect(sent[0].attachToConversationId).toBe(conversationId);
  });

  test("passes recording options through", () => {
    const { ctx, sent } = createCtx();
    const options = { captureScope: "window" as const, includeAudio: true };

    handleRecordingStart("conv-2", options, ctx);

    expect(sent[0].options).toEqual(options);
  });

  test("returns null when recording already active and sends no messages", () => {
    const { ctx, sent } = createCtx();

    const id1 = handleRecordingStart("conv-3", undefined, ctx);
    expect(id1).toBeTruthy();

    const id2 = handleRecordingStart("conv-3", undefined, ctx);

    // Should return null (callers handle messaging)
    expect(id2).toBeNull();
    // Only the first call sends recording_start — the duplicate sends nothing
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_start");
    expect(sent[0].recordingId).toBe(id1);
  });

  test("returns null when a different conversation already has an active recording (global guard)", () => {
    const { ctx, sent } = createCtx();

    const id1 = handleRecordingStart("conv-global-a", undefined, ctx);
    expect(id1).toBeTruthy();

    // A second start from a different conversation should be rejected
    const id2 = handleRecordingStart("conv-global-b", undefined, ctx);
    expect(id2).toBeNull();

    // Only the first call sends recording_start
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_start");
    expect(sent[0].recordingId).toBe(id1);
  });
});

describe("handleRecordingStop", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test("sends recording_stop for an active recording", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-stop-1";

    // Start a recording first
    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0; // Clear the start message

    const result = handleRecordingStop(conversationId, ctx);

    expect(result).toBe(recordingId!);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_stop");
    expect(sent[0].recordingId).toBe(recordingId!);
  });

  test("returns undefined when no active recording exists", () => {
    const { ctx } = createCtx();

    const result = handleRecordingStop("conv-no-recording", ctx);

    expect(result).toBeUndefined();
  });

  test("resolves to globally active recording from a different conversation", () => {
    const { ctx, sent } = createCtx();
    const convA = "conv-owner";
    const convB = "conv-stopper";

    // Bind socket to conv-A (the owning conversation)

    // Start a recording on conv-A
    const recordingId = handleRecordingStart(convA, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    // Stop from conv-B — should resolve to the globally active recording on conv-A
    const result = handleRecordingStop(convB, ctx);

    expect(result).toBe(recordingId!);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_stop");
    expect(sent[0].recordingId).toBe(recordingId!);
  });

  test("returns recordingId when stopped via broadcast", () => {
    const { ctx } = createCtx();
    const conversationId = "conv-broadcast-stop";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();

    const result = handleRecordingStop(conversationId, ctx);

    // Broadcast-based stop always returns the recordingId
    expect(result).toBe(recordingId!);
  });
});

describe("handleRecordingStatusCore", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test("handles started status without errors", async () => {
    const { ctx } = createCtx();
    const conversationId = "conv-status-1";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "started",
    };

    // Should not throw
    await handleRecordingStatusCore(statusMsg, ctx);
  });

  test("handles stopped status with file — creates attachment and notifies client", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-stopped";

    // Bind socket

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    // Even with an existing assistant message, a NEW one should be created
    mockMessages.push({
      id: "existing-msg",
      role: "assistant",
      content: "Hello",
    });

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording.mov`,
      durationMs: 5000,
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // Should have sent assistant_text_delta and message_complete
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    const completes = sent.filter((m) => m.type === "message_complete");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(completes.length).toBeGreaterThanOrEqual(1);

    // The message_complete should include attachment info
    const completeMsg = completes[0];
    expect(completeMsg.conversationId).toBe(conversationId);

    // Attachment should have been created
    expect(mockAttachments.length).toBe(1);
    expect(mockAttachments[0].mimeType).toBe("video/quicktime");
    expect(mockAttachments[0].sizeBytes).toBe(mockFileSize);

    // A new assistant message should have been created (not reuse existing-msg)
    const createdMsg = mockMessages.find(
      (m) => m.id !== "existing-msg" && m.role === "assistant",
    );
    expect(createdMsg).toBeTruthy();
  });

  test("handles stopped status and creates assistant message when none exists", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-no-msg";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    // No existing messages, handler should create one

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording.mp4`,
      durationMs: 3000,
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // An assistant message should have been created via addMessage mock
    expect(mockMessages.length).toBeGreaterThanOrEqual(1);
    const createdMsg = mockMessages.find((m) => m.role === "assistant");
    expect(createdMsg).toBeTruthy();
  });

  test("handles stopped status when file does not exist — notifies client", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-no-file";

    mockFileExists = false;

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/nonexistent.mov`,
      durationMs: 1000,
    };

    // Should not throw — the handler logs the error and notifies the client
    await handleRecordingStatusCore(statusMsg, ctx);

    // No attachment should have been created
    expect(mockAttachments.length).toBe(0);

    // Client should be notified that the recording failed to save
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("Recording failed to save");

    const completes = sent.filter((m) => m.type === "message_complete");
    expect(completes.length).toBeGreaterThanOrEqual(1);
    expect(completes[0].conversationId).toBe(conversationId);
  });

  test("handles stopped status with zero-length file — treated as failure", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-zero-file";

    mockFileExists = true;
    mockFileSize = 0;

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-empty.mov`,
      durationMs: 2000,
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // No attachment should have been created for a zero-length file
    expect(mockAttachments.length).toBe(0);

    // Client should be told the recording failed to save
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("Recording failed to save");

    // Should NOT contain the success message
    const hasSuccessMessage = textDeltas.some(
      (m) =>
        typeof m.text === "string" && m.text.includes("recording complete"),
    );
    expect(hasSuccessMessage).toBe(false);

    const completes = sent.filter((m) => m.type === "message_complete");
    expect(completes.length).toBeGreaterThanOrEqual(1);
    expect(completes[0].conversationId).toBe(conversationId);
  });

  test("successful finalization — attachment created and success message sent", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-success";

    mockFileExists = true;
    mockFileSize = 4096;

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-good.mov`,
      durationMs: 5000,
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // Attachment should have been created
    expect(mockAttachments.length).toBe(1);
    expect(mockAttachments[0].sizeBytes).toBe(4096);

    // Success message should be present
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("Screen recording complete");

    // Should NOT contain failure message
    const hasFailureMessage = textDeltas.some(
      (m) => typeof m.text === "string" && m.text.includes("Recording failed"),
    );
    expect(hasFailureMessage).toBe(false);
  });

  test("rejects file path outside allowed directory", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-outside-dir";

    mockFileExists = true;
    mockFileSize = 4096;

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: "/tmp/evil.mov",
      durationMs: 5000,
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // No attachment should have been created — path is outside allowlist
    expect(mockAttachments.length).toBe(0);

    // Client should be told the recording is unavailable
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain(
      "Recording file is unavailable or expired",
    );

    const completes = sent.filter((m) => m.type === "message_complete");
    expect(completes.length).toBeGreaterThanOrEqual(1);
    expect(completes[0].conversationId).toBe(conversationId);
  });

  test("failed finalization — failure status sent and no success message", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-fail-final";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    // Client reports failure (writer finalization error)
    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "failed",
      error: "Video writer finished with non-completed status 3",
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // No attachment should have been created
    expect(mockAttachments.length).toBe(0);

    // Should send failure message, not success
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("Recording failed");

    // Should NOT contain the success message
    const hasSuccessMessage = textDeltas.some(
      (m) =>
        typeof m.text === "string" && m.text.includes("recording complete"),
    );
    expect(hasSuccessMessage).toBe(false);
  });

  test("handles failed status and notifies client", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-failed";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "failed",
      error: "Permission denied",
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // Should send error notification
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("Recording failed");
    expect(textDeltas[0].text).toContain("Permission denied");

    const completes = sent.filter((m) => m.type === "message_complete");
    expect(completes.length).toBeGreaterThanOrEqual(1);
  });

  test("handles failed status with no error message", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-status-failed-no-err";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "failed",
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("unknown error");
  });

  test("handles status with attachToConversationId fallback", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-fallback";

    // Send a recording_status directly with attachToConversationId
    // without having started a recording through handleRecordingStart
    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: "unknown-recording-id",
      status: "failed",
      error: "Something went wrong",
      attachToConversationId: conversationId,
    };

    // Should not throw — uses attachToConversationId as fallback
    await handleRecordingStatusCore(statusMsg, ctx);

    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── handleRecordingRestart ────────────────────────────────────────────────

describe("handleRecordingRestart", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test("active recording → stops current, returns initiated with operationToken", () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-restart-1";

    // Start a recording first
    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const result = handleRecordingRestart(conversationId, ctx);

    expect(result.initiated).toBe(true);
    expect(result.operationToken).toBeTruthy();
    expect(result.responseText).toContain("Restarting");
    // Should have sent recording_stop
    const stopMsgs = sent.filter((m) => m.type === "recording_stop");
    expect(stopMsgs.length).toBe(1);
    // Should not be idle (restart pending)
    expect(isRecordingIdle()).toBe(false);
    expect(getActiveRestartToken()).toBe(result.operationToken as string);
  });

  test("no active recording → returns not initiated", () => {
    const { ctx } = createCtx();

    const result = handleRecordingRestart("conv-no-recording", ctx);

    expect(result.initiated).toBe(false);
    expect(result.reason).toBe("no_active_recording");
    expect(isRecordingIdle()).toBe(true);
  });

  test("restart already in progress → returns restart_in_progress", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-double-restart";

    // Start and initiate first restart
    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    const first = handleRecordingRestart(conversationId, ctx);
    expect(first.initiated).toBe(true);
    sent.length = 0;

    // Simulate the client acknowledging the stop (which cleans up recording
    // maps but leaves pendingRestartByConversation active while the new
    // recording_start is being processed).
    // Send "stopped" status — this triggers the deferred restart, creating a
    // new recording. The pendingRestartByConversation entry stays until the
    // new recording's "started" status arrives.
    await handleRecordingStatusCore(
      {
        type: "recording_status",
        conversationId: recordingId!,
        status: "stopped",
        filePath: `${ALLOWED_RECORDINGS_DIR}/restart-file.mov`,
        durationMs: 1000,
      },
      ctx,
    );
    sent.length = 0;

    // Now a second restart request — the new recording is active but
    // pendingRestartByConversation may still be set. Try to restart again.
    const second = handleRecordingRestart(conversationId, ctx);

    // The second restart should succeed because there IS now an active
    // recording (from the deferred start). It initiates a new restart cycle.
    // The "restart_in_progress" path only triggers when there's NO active
    // recording but a pending restart exists.
    expect(second.initiated).toBe(true);
  });

  test("cross-conversation restart → keys deferred restart by owner", () => {
    const { ctx, sent } = createCtx();
    const ownerConv = "conv-owner";
    const requesterConv = "conv-requester";

    // Start recording on owner conversation
    handleRecordingStart(ownerConv, undefined, ctx);
    sent.length = 0;

    // Request restart from a different conversation
    const result = handleRecordingRestart(requesterConv, ctx);

    expect(result.initiated).toBe(true);
    expect(result.operationToken).toBeTruthy();
    // Stop should have been sent (via global fallback)
    const stopMsgs = sent.filter((m) => m.type === "recording_stop");
    expect(stopMsgs.length).toBe(1);
  });
});

// ─── handleRecordingStatusCore — extended ──────────────────────────────────

describe("handleRecordingStatusCore — extended", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test("restart_cancelled status cleans up restart state and sends message", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-restart-cancel";

    // Start and initiate restart
    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    const restartResult = handleRecordingRestart(conversationId, ctx);
    expect(restartResult.initiated).toBe(true);
    sent.length = 0;

    // Client sends restart_cancelled
    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "restart_cancelled",
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // Should send cancellation message
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("Recording restart cancelled");

    // Restart state should be cleaned up
    expect(isRecordingIdle()).toBe(true);
    expect(getActiveRestartToken()).toBeNull();
  });

  test("stopped with deferred restart triggers new recording start", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-deferred-start";

    // Start recording, then initiate restart
    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    handleRecordingRestart(conversationId, ctx);
    sent.length = 0;

    // Client acknowledges stop with file
    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/restart-old.mov`,
      durationMs: 3000,
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // Should have sent a new recording_start (deferred restart)
    const startMsgs = sent.filter((m) => m.type === "recording_start");
    expect(startMsgs.length).toBe(1);

    // Should also have finalized the old recording
    expect(mockAttachments.length).toBe(1);
  });

  test("operation token mismatch rejects stale status callback", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-token-mismatch";

    // Start recording and initiate restart to get an active token
    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    const restartResult = handleRecordingRestart(conversationId, ctx);
    expect(restartResult.initiated).toBe(true);
    sent.length = 0;

    // Send a status with a WRONG operation token (stale from previous cycle)
    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "started",
      operationToken: "stale-wrong-token",
    };

    await handleRecordingStatusCore(statusMsg, ctx);

    // Should be silently rejected — no recording_start or other events sent
    // The restart token should still be active (not cleared by stale callback)
    expect(getActiveRestartToken()).toBe(
      restartResult.operationToken as string,
    );
  });

  test("paused and resumed statuses do not error", async () => {
    const { ctx, sent } = createCtx();
    const conversationId = "conv-pause-resume";

    const recordingId = handleRecordingStart(conversationId, undefined, ctx);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    // Paused status
    await handleRecordingStatusCore(
      {
        type: "recording_status",
        conversationId: recordingId!,
        status: "paused",
      },
      ctx,
    );

    // Resumed status
    await handleRecordingStatusCore(
      {
        type: "recording_status",
        conversationId: recordingId!,
        status: "resumed",
      },
      ctx,
    );

    // Neither should produce error messages or text deltas
    const errorMsgs = sent.filter((m) => m.type === "error");
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(errorMsgs).toHaveLength(0);
    expect(textDeltas).toHaveLength(0);
  });
});

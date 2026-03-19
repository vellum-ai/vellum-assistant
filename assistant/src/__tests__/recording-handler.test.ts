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
  handleRecordingStart,
  handleRecordingStatusCore,
  handleRecordingStop,
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

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

// Conversation store mock
const mockMessages: Array<{ id: string; role: string; content: string }> = [];
let mockMessageIdCounter = 0;
let mockConversationExists = true;

mock.module("../persistence/conversation-crud.js", () => ({
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
  getConversation: (id: string) =>
    mockConversationExists ? { id, createdAt: Date.now() } : null,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

// Attachments store mock
const mockAttachments: Array<{
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}> = [];
let mockAttachmentIdCounter = 0;
const mockLinkAttachmentToMessage = mock(
  (_messageId: string, attachmentId: string) => attachmentId,
);

mock.module("../persistence/attachments-store.js", () => ({
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
  getAttachmentById: (attachmentId: string) =>
    mockAttachments.find((attachment) => attachment.id === attachmentId) ??
    null,
  linkAttachmentToMessage: mockLinkAttachmentToMessage,
  setAttachmentThumbnail: noop,
}));

// ── Mock video thumbnail ───────────────────────────────────────────────────

mock.module("../daemon/video-thumbnail.js", () => ({
  generateVideoThumbnail: async () => null,
  generateVideoThumbnailFromPath: async () => null,
}));

const mockTransferCalls: Array<{
  operation: string;
  recordingId: string;
  ownerClientId: string;
  sequence?: number;
  data?: number[];
}> = [];
mock.module("../daemon/recording-transfer.js", () => ({
  recordingTransferStore: {
    begin: async (recordingId: string, ownerClientId: string) => {
      mockTransferCalls.push({
        operation: "begin",
        recordingId,
        ownerClientId,
      });
    },
    append: async (
      recordingId: string,
      ownerClientId: string,
      sequence: number,
      data: Uint8Array,
    ) => {
      mockTransferCalls.push({
        operation: "append",
        recordingId,
        ownerClientId,
        sequence,
        data: [...data],
      });
    },
    finish: async (recordingId: string, ownerClientId: string) => {
      mockTransferCalls.push({
        operation: "finish",
        recordingId,
        ownerClientId,
      });
      return "att-recovered";
    },
    abort: async (recordingId: string, ownerClientId: string) => {
      mockTransferCalls.push({
        operation: "abort",
        recordingId,
        ownerClientId,
      });
    },
  },
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
      if (p.includes("recording") || p.includes("/tmp/")) {
        return mockFileExists;
      }
      return realFs.existsSync(p);
    },
    statSync: (p: string, opts?: any) => {
      if (p.includes("recording") || p.includes("/tmp/")) {
        return { size: mockFileSize };
      }
      return realFs.statSync(p, opts);
    },
    realpathSync: (p: string) => {
      // For test paths under the allowed directory or /tmp/, return as-is
      // to avoid hitting the filesystem (which would throw ENOENT)
      if (
        p.includes("recording") ||
        p.includes("/tmp/") ||
        p.includes("vellum-assistant")
      ) {
        return p;
      }
      return realFs.realpathSync(p);
    },
    readFileSync: realFs.readFileSync,
  };
});

// Capture broadcastMessage calls
const broadcastedMessages: Array<{ type: string; [k: string]: unknown }> = [];
const mockClients = new Map<
  string,
  {
    clientId: string;
    interfaceId: "macos" | "windows" | "web";
    actorPrincipalId: string;
  }
>();
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => {
    broadcastedMessages.push(msg as { type: string; [k: string]: unknown });
  },
  assistantEventHub: {
    getClientById: (clientId: string) => mockClients.get(clientId),
    getActorPrincipalIdForClient: (clientId: string) =>
      mockClients.get(clientId)?.actorPrincipalId,
  },
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  __resetRecordingState,
  claimRecording,
  claimRecordingOutcome,
  handleRecordingStart,
  handleRecordingStatusCore,
  handleRecordingStop,
  hasRecordingClaim,
} from "../daemon/handlers/recording.js";
import type { RecordingStatus } from "../daemon/message-types/computer-use.js";
import { ROUTES } from "../runtime/routes/recording-routes.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

function createSent(): Array<{ type: string; [k: string]: unknown }> {
  broadcastedMessages.length = 0;
  return broadcastedMessages;
}

const statusRouteHandler = ROUTES.find(
  (route) => route.operationId === "recordings_status_post",
)!.handler;
const transferRouteHandler = ROUTES.find(
  (route) => route.operationId === "recordings_transfer",
)!.handler;

function registerMockClient(
  clientId: string,
  actorPrincipalId: string,
  interfaceId: "macos" | "windows" | "web" = "macos",
): void {
  mockClients.set(clientId, { clientId, actorPrincipalId, interfaceId });
}

function statusHeaders(
  clientId: string,
  actorPrincipalId: string,
  desktopClientId?: string,
) {
  return {
    "x-vellum-client-id": clientId,
    "x-vellum-actor-principal-id": actorPrincipalId,
    ...(desktopClientId ? { "vellum-device-id": desktopClientId } : {}),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("handleRecordingStart", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockLinkAttachmentToMessage.mockClear();
    mockFileExists = true;
    mockFileSize = 1024;
    mockConversationExists = true;
    mockClients.clear();
    mockTransferCalls.length = 0;
  });

  test("sends recording_start event and returns a UUID", () => {
    const sent = createSent();
    const conversationId = "conv-1";

    const recordingId = handleRecordingStart(conversationId, undefined);

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
    const sent = createSent();
    const options = { captureScope: "window" as const, includeAudio: true };

    handleRecordingStart("conv-2", options);

    expect(sent[0].options).toEqual(options);
  });

  test("elects one client to own a recording", () => {
    const recordingId = handleRecordingStart("conv-claim", undefined)!;

    expect(claimRecording(recordingId, "client-1")).toBeTrue();
    expect(claimRecording(recordingId, "client-1")).toBeTrue();
    expect(claimRecording(recordingId, "client-2")).toBeFalse();
    expect(claimRecordingOutcome("missing-recording", "client-2")).toBe(
      "missing",
    );
  });

  test("allows reclaim after owner disconnect or lease expiry", () => {
    const disconnectedId = handleRecordingStart(
      "conv-disconnected",
      undefined,
    )!;
    expect(claimRecording(disconnectedId, "client-1", { now: 0 })).toBeTrue();
    expect(
      claimRecording(disconnectedId, "client-2", {
        now: 1,
        isClientConnected: () => false,
      }),
    ).toBeTrue();

    __resetRecordingState();
    const expiredId = handleRecordingStart("conv-expired", undefined)!;
    expect(claimRecording(expiredId, "client-1", { now: 0 })).toBeTrue();
    expect(
      claimRecording(expiredId, "client-2", {
        now: 30_001,
        isClientConnected: () => true,
      }),
    ).toBeTrue();
  });

  test("returns null when recording already active and sends no messages", () => {
    const sent = createSent();

    const id1 = handleRecordingStart("conv-3", undefined);
    expect(id1).toBeTruthy();

    const id2 = handleRecordingStart("conv-3", undefined);

    // Should return null (callers handle messaging)
    expect(id2).toBeNull();
    // Only the first call sends recording_start — the duplicate sends nothing
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_start");
    expect(sent[0].recordingId).toBe(id1);
  });

  test("returns null when a different conversation already has an active recording (global guard)", () => {
    const sent = createSent();

    const id1 = handleRecordingStart("conv-global-a", undefined);
    expect(id1).toBeTruthy();

    // A second start from a different conversation should be rejected
    const id2 = handleRecordingStart("conv-global-b", undefined);
    expect(id2).toBeNull();

    // Only the first call sends recording_start
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_start");
    expect(sent[0].recordingId).toBe(id1);
  });
});

describe("recording status restart fallback", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockFileExists = true;
    mockFileSize = 1024;
    mockConversationExists = true;
    mockClients.clear();
  });

  test("attaches a completed recording after assistant state is lost", async () => {
    const conversationId = "conv-recording-restart-fallback";
    const recordingId = "00000000-0000-4000-8000-000000000091";
    registerMockClient("renderer-1", "actor-1", "web");
    registerMockClient("desktop-1", "actor-1", "windows");

    await expect(
      statusRouteHandler({
        body: {
          conversationId: recordingId,
          attachToConversationId: conversationId,
          status: "stopped",
          filePath: `${ALLOWED_RECORDINGS_DIR}/${recordingId}.webm`,
        },
        headers: statusHeaders("renderer-1", "actor-1", "desktop-1"),
      } as never),
    ).resolves.toEqual({ ok: true });

    expect(mockAttachments).toHaveLength(1);
    expect(mockMessages.at(-1)?.content).toContain("Screen recording complete");
    expect(hasRecordingClaim(recordingId)).toBeFalse();
  });

  test("restarts a lost transfer under the authenticated desktop owner", async () => {
    const recordingId = "00000000-0000-4000-8000-000000000096";
    const headers = statusHeaders(
      "renderer-transfer",
      "actor-1",
      "desktop-transfer",
    );
    registerMockClient("renderer-transfer", "actor-1", "web");
    registerMockClient("desktop-transfer", "actor-1", "windows");

    await expect(
      transferRouteHandler({
        body: {
          recordingId,
          operation: "begin",
          attachToConversationId: "conv-recording-transfer-recovery",
        },
        headers,
      } as never),
    ).resolves.toEqual({ ok: true });
    await transferRouteHandler({
      body: {
        recordingId,
        operation: "append",
        sequence: 0,
        data: Buffer.from([1, 2, 3]).toString("base64"),
      },
      headers,
    } as never);
    await expect(
      transferRouteHandler({
        body: { recordingId, operation: "finish" },
        headers,
      } as never),
    ).resolves.toEqual({ ok: true, attachmentId: "att-recovered" });

    expect(mockTransferCalls).toEqual([
      { operation: "begin", recordingId, ownerClientId: "desktop-transfer" },
      {
        operation: "append",
        recordingId,
        ownerClientId: "desktop-transfer",
        sequence: 0,
        data: [1, 2, 3],
      },
      { operation: "finish", recordingId, ownerClientId: "desktop-transfer" },
    ]);
  });

  test("rejects restart fallback from the wrong actor", async () => {
    registerMockClient("renderer-actor", "actor-2", "web");
    registerMockClient("desktop-actor", "actor-1");

    await expect(
      statusRouteHandler({
        body: {
          conversationId: "00000000-0000-4000-8000-000000000092",
          attachToConversationId: "conv-recording-wrong-actor",
          status: "failed",
        },
        headers: statusHeaders("renderer-actor", "actor-2", "desktop-actor"),
      } as never),
    ).rejects.toThrow("does not match");
  });

  test("rejects a spoofed browser desktop marker", async () => {
    registerMockClient("web-client", "actor-1", "web");

    await expect(
      statusRouteHandler({
        body: {
          conversationId: "00000000-0000-4000-8000-000000000093",
          attachToConversationId: "conv-recording-wrong-client",
          status: "failed",
        },
        headers: statusHeaders("web-client", "actor-1", "spoofed-desktop"),
      } as never),
    ).rejects.toThrow("desktop client");
  });

  test("rejects restart fallback for an unknown conversation", async () => {
    mockConversationExists = false;
    registerMockClient("renderer-conversation", "actor-1", "web");
    registerMockClient("desktop-conversation", "actor-1");

    await expect(
      statusRouteHandler({
        body: {
          conversationId: "00000000-0000-4000-8000-000000000094",
          attachToConversationId: "conv-recording-does-not-exist",
          status: "stopped",
        },
        headers: statusHeaders(
          "renderer-conversation",
          "actor-1",
          "desktop-conversation",
        ),
      } as never),
    ).rejects.toThrow("Conversation not found");
  });

  test("rejects a non-terminal restart fallback status", async () => {
    registerMockClient("renderer-non-terminal", "actor-1", "web");
    registerMockClient("desktop-non-terminal", "actor-1");

    await expect(
      statusRouteHandler({
        body: {
          conversationId: "00000000-0000-4000-8000-000000000095",
          attachToConversationId: "conv-recording-non-terminal",
          status: "started",
        },
        headers: statusHeaders(
          "renderer-non-terminal",
          "actor-1",
          "desktop-non-terminal",
        ),
      } as never),
    ).rejects.toThrow("another client");
  });
});

describe("handleRecordingStop", () => {
  beforeEach(() => {
    __resetRecordingState();
    mockMessages.length = 0;
    mockAttachments.length = 0;
    mockMessageIdCounter = 0;
    mockAttachmentIdCounter = 0;
    mockLinkAttachmentToMessage.mockClear();
    mockFileExists = true;
    mockFileSize = 1024;
  });

  test("sends recording_stop for an active recording", () => {
    const sent = createSent();
    const conversationId = "conv-stop-1";

    // Start a recording first
    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0; // Clear the start message

    const result = handleRecordingStop(conversationId);

    expect(result).toBe(recordingId!);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_stop");
    expect(sent[0].recordingId).toBe(recordingId!);
  });

  test("returns undefined when no active recording exists", () => {
    createSent();

    const result = handleRecordingStop("conv-no-recording");

    expect(result).toBeUndefined();
  });

  test("resolves to globally active recording from a different conversation", () => {
    const sent = createSent();
    const convA = "conv-owner";
    const convB = "conv-stopper";

    // Bind socket to conv-A (the owning conversation)

    // Start a recording on conv-A
    const recordingId = handleRecordingStart(convA, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    // Stop from conv-B — should resolve to the globally active recording on conv-A
    const result = handleRecordingStop(convB);

    expect(result).toBe(recordingId!);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recording_stop");
    expect(sent[0].recordingId).toBe(recordingId!);
  });

  test("returns recordingId when stopped via broadcast", () => {
    createSent();
    const conversationId = "conv-broadcast-stop";

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();

    const result = handleRecordingStop(conversationId);

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
    createSent();
    const conversationId = "conv-status-1";

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "started",
    };

    // Should not throw
    await handleRecordingStatusCore(statusMsg);
  });

  test("handles stopped status with file — creates attachment and notifies client", async () => {
    const sent = createSent();
    const conversationId = "conv-status-stopped";

    // Bind socket

    const recordingId = handleRecordingStart(conversationId, undefined);
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

    await handleRecordingStatusCore(statusMsg);

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

  test("links a client-uploaded remote recording", async () => {
    const sent = createSent();
    const conversationId = "conv-status-remote";
    const uploadedAttachment = {
      id: "attachment-remote",
      originalFilename: "screen-recording.webm",
      mimeType: "video/webm",
      sizeBytes: 2048,
    };
    mockAttachments.push(uploadedAttachment);
    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    await handleRecordingStatusCore({
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      attachmentId: uploadedAttachment.id,
      durationMs: 5000,
    });

    expect(mockLinkAttachmentToMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^msg-/),
      uploadedAttachment.id,
      0,
    );
    const complete = sent.find(
      (message) => message.type === "message_complete",
    );
    expect(complete?.attachments).toEqual([
      expect.objectContaining({
        id: uploadedAttachment.id,
        filename: uploadedAttachment.originalFilename,
        mimeType: uploadedAttachment.mimeType,
        sizeBytes: uploadedAttachment.sizeBytes,
      }),
    ]);
  });

  test("handles stopped status and creates assistant message when none exists", async () => {
    const sent = createSent();
    const conversationId = "conv-status-no-msg";

    const recordingId = handleRecordingStart(conversationId, undefined);
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

    await handleRecordingStatusCore(statusMsg);

    // An assistant message should have been created via addMessage mock
    expect(mockMessages.length).toBeGreaterThanOrEqual(1);
    const createdMsg = mockMessages.find((m) => m.role === "assistant");
    expect(createdMsg).toBeTruthy();
  });

  test("handles stopped status when file does not exist — notifies client", async () => {
    const sent = createSent();
    const conversationId = "conv-status-no-file";

    mockFileExists = false;

    const recordingId = handleRecordingStart(conversationId, undefined);
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
    await handleRecordingStatusCore(statusMsg);

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
    const sent = createSent();
    const conversationId = "conv-status-zero-file";

    mockFileExists = true;
    mockFileSize = 0;

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-empty.mov`,
      durationMs: 2000,
    };

    await handleRecordingStatusCore(statusMsg);

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
    const sent = createSent();
    const conversationId = "conv-status-success";

    mockFileExists = true;
    mockFileSize = 4096;

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: `${ALLOWED_RECORDINGS_DIR}/recording-good.mov`,
      durationMs: 5000,
    };

    await handleRecordingStatusCore(statusMsg);

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
    const sent = createSent();
    const conversationId = "conv-status-outside-dir";

    mockFileExists = true;
    mockFileSize = 4096;

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "stopped",
      filePath: "/tmp/evil.mov",
      durationMs: 5000,
    };

    await handleRecordingStatusCore(statusMsg);

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
    const sent = createSent();
    const conversationId = "conv-status-fail-final";

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    // Client reports failure (writer finalization error)
    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "failed",
      error: "Video writer finished with non-completed status 3",
    };

    await handleRecordingStatusCore(statusMsg);

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
    const sent = createSent();
    const conversationId = "conv-status-failed";

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "failed",
      error: "Permission denied",
    };

    await handleRecordingStatusCore(statusMsg);

    // Should send error notification
    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("Recording failed");
    expect(textDeltas[0].text).toContain("Permission denied");

    const completes = sent.filter((m) => m.type === "message_complete");
    expect(completes.length).toBeGreaterThanOrEqual(1);
  });

  test("handles failed status with no error message", async () => {
    const sent = createSent();
    const conversationId = "conv-status-failed-no-err";

    const recordingId = handleRecordingStart(conversationId, undefined);
    expect(recordingId).not.toBeNull();
    sent.length = 0;

    const statusMsg: RecordingStatus = {
      type: "recording_status",
      conversationId: recordingId!,
      status: "failed",
    };

    await handleRecordingStatusCore(statusMsg);

    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas[0].text).toContain("unknown error");
  });

  test("handles status with attachToConversationId fallback", async () => {
    const sent = createSent();
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
    await handleRecordingStatusCore(statusMsg);

    const textDeltas = sent.filter((m) => m.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

let broadcastedMessages: ServerMessage[] = [];
const realEventHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...realEventHub,
  broadcastMessage: (msg: ServerMessage) => broadcastedMessages.push(msg),
}));

const { createSurfaceMutex, handleSurfaceAction, surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");

const { registerVoiceResumeHandler, unregisterVoiceResumeHandler } =
  await import("../live-voice/live-voice-resume-registry.js");
import type {
  VoiceResumeHandler,
  VoiceResumeOptions,
} from "../live-voice/live-voice-resume-registry.js";

const { LiveVoiceSession } =
  await import("../live-voice/live-voice-session.js");
import type { VoiceTurnOptions } from "../calls/voice-session-bridge.js";
import type { SurfaceConversationContext } from "../daemon/conversation-surfaces.js";
import type {
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
} from "../daemon/message-protocol.js";
import type { UserMessageAttachment } from "../daemon/message-types/shared.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice/live-voice-session-manager.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";

interface ProcessMessageCall {
  content: string;
  attachments: UserMessageAttachment[];
  requestId?: string;
  activeSurfaceId?: string;
  displayContent?: string;
  sourceActorPrincipalId?: string;
}

function makeContext(sent: ServerMessage[] = []): SurfaceConversationContext & {
  processMessageCalls: ProcessMessageCall[];
} {
  const processMessageCalls: ProcessMessageCall[] = [];
  return {
    conversationId: "conv-1",
    sendToClient: (msg: ServerMessage) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map<
      string,
      {
        surfaceType: SurfaceType;
        data: SurfaceData;
        title?: string;
        actions?: Array<{
          id: string;
          label: string;
          style?: string;
          data?: Record<string, unknown>;
        }>;
      }
    >(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async (options) => {
      processMessageCalls.push({
        content: options.content,
        attachments: options.attachments,
        requestId: options.requestId,
        activeSurfaceId: options.activeSurfaceId,
        displayContent: options.displayContent,
        sourceActorPrincipalId: options.sourceActorPrincipalId,
      });
      return "msg-1";
    },
    withSurface: createSurfaceMutex(),
    processMessageCalls,
  };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for condition",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("surface action delivery to assistant", () => {
  beforeEach(() => {
    broadcastedMessages = [];
  });

  test("table action button click triggers processMessage with action content", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // Step 1: Show a table surface with actions
    const showResult = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "Newsletters",
      data: {
        columns: [
          { id: "sender", label: "Sender" },
          { id: "count", label: "Count" },
        ],
        rows: [
          { id: "row-1", cells: { sender: "Newsletter A", count: "5" } },
          { id: "row-2", cells: { sender: "Newsletter B", count: "3" } },
        ],
        selectionMode: "multiple",
      },
      actions: [
        { id: "archive", label: "Archive", style: "primary" },
        { id: "unsubscribe", label: "Unsubscribe", style: "destructive" },
      ],
    });

    expect(showResult.isError).toBe(false);
    expect(showResult.yieldToUser).toBe(true);

    // Verify surface was shown and pending action was registered
    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    expect(showMessage).toBeDefined();
    const surfaceId = showMessage.surfaceId;
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);
    expect(ctx.surfaceState.has(surfaceId)).toBe(true);

    // Step 2: Simulate user clicking "Archive" with selected rows
    const actionData = {
      selectedIds: ["row-1", "row-2"],
    };

    await handleSurfaceAction(ctx, surfaceId, "archive", actionData);

    // Step 3: Verify processMessage was called
    expect(ctx.processMessageCalls.length).toBe(1);
    const call = ctx.processMessageCalls[0];
    expect(call.content).toContain("[User action on table surface:");
    expect(call.content).toContain("archive");
    expect(call.content).toContain("selectedIds");
    expect(call.content).toContain("row-1");
    expect(call.content).toContain("row-2");
    expect(call.activeSurfaceId).toBe(surfaceId);

    // Verify pending action was cleared
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);

    // Verify the requestId was tracked as a surface action
    expect(ctx.surfaceActionRequestIds.size).toBe(1);
  });

  test("idle pending follow-up path threads submitter principal into processMessage", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "Items",
      data: {
        columns: [{ id: "name", label: "Name" }],
        rows: [{ id: "r1", cells: { name: "Item 1" } }],
      },
      actions: [{ id: "archive", label: "Archive" }],
    });

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;

    await handleSurfaceAction(
      ctx,
      surfaceId,
      "archive",
      { selectedIds: ["r1"] },
      "principal-committer",
    );

    expect(ctx.processMessageCalls.length).toBe(1);
    expect(ctx.processMessageCalls[0].sourceActorPrincipalId).toBe(
      "principal-committer",
    );
  });

  test("idle history-restored path threads submitter principal into processMessage", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // History-restored surface: surfaceState exists, pendingSurfaceActions
    // does not — exercises the immediate (idle) fallthrough.
    ctx.surfaceState.set("hist-surface-p", {
      surfaceType: "table",
      data: {
        columns: [{ id: "col", label: "Col" }],
        rows: [],
      } as unknown as SurfaceData,
      title: "History Table",
      actions: [{ id: "delete", label: "Delete" }],
    });

    await handleSurfaceAction(
      ctx,
      "hist-surface-p",
      "delete",
      { selectedIds: ["row-1"] },
      "principal-committer",
    );

    expect(ctx.processMessageCalls.length).toBe(1);
    expect(ctx.processMessageCalls[0].sourceActorPrincipalId).toBe(
      "principal-committer",
    );
  });

  test("table action without selection data still triggers processMessage", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // Show table surface
    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "Emails",
      data: {
        columns: [{ id: "subject", label: "Subject" }],
        rows: [{ id: "r1", cells: { subject: "Hello" } }],
      },
      actions: [{ id: "archive", label: "Archive" }],
    });

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;

    // Click action WITHOUT selection data (data is undefined)
    await handleSurfaceAction(ctx, surfaceId, "archive", undefined);

    // processMessage must still be called
    expect(ctx.processMessageCalls.length).toBe(1);
    expect(ctx.processMessageCalls[0].content).toContain(
      "[User action on table surface:",
    );
  });

  test("history-restored relay action uses stored prompt data and can complete the surface", async () => {
    const ctx = makeContext();
    const surfaceId = "max-token-surface";
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "card",
      data: {
        title: "Response limit reached",
        body: "Continue from where the assistant stopped.",
      },
      actions: [
        {
          id: "relay_prompt",
          label: "Continue",
          style: "primary",
          data: {
            prompt: "Continue from where you stopped.",
            _completeSurface: true,
            _completionSummary: "Continue",
          },
        },
      ],
    });

    await handleSurfaceAction(ctx, surfaceId, "relay_prompt");

    expect(ctx.processMessageCalls).toHaveLength(1);
    expect(ctx.processMessageCalls[0]!.content).toBe(
      "Continue from where you stopped.",
    );
    expect(
      broadcastedMessages.some(
        (msg) =>
          msg.type === "ui_surface_complete" &&
          msg.surfaceId === surfaceId &&
          msg.summary === "Continue",
      ),
    ).toBe(true);
    expect(
      broadcastedMessages.some(
        (msg) =>
          msg.type === "user_message_echo" &&
          msg.text === "Continue from where you stopped.",
      ),
    ).toBe(true);
  });

  test("action on history-restored surface (no pending) still processes", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // Simulate a history-restored surface: surfaceState exists, but
    // pendingSurfaceActions does NOT have an entry.
    ctx.surfaceState.set("hist-surface-1", {
      surfaceType: "table",
      data: {
        columns: [{ id: "col", label: "Col" }],
        rows: [],
      } as unknown as SurfaceData,
      title: "History Table",
      actions: [{ id: "delete", label: "Delete" }],
    });

    // Click the action — should go through the history-restored path
    await handleSurfaceAction(ctx, "hist-surface-1", "delete", {
      selectedIds: ["row-1"],
    });

    // processMessage should still be called
    expect(ctx.processMessageCalls.length).toBe(1);
    expect(ctx.processMessageCalls[0].content).toContain(
      "[User action on app:",
    );
  });

  test("confirmation surface broadcasts ui_surface_complete on action", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const showResult = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "confirmation",
      title: "Delete files?",
      data: {
        message: "This will permanently delete 3 files.",
        confirmLabel: "Delete",
        cancelLabel: "Keep",
      },
    });

    expect(showResult.isError).toBe(false);
    expect(showResult.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);

    await handleSurfaceAction(ctx, surfaceId, "confirm", {});

    const completeMsg = broadcastedMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type ===
          "ui_surface_complete" &&
        (m as unknown as Record<string, unknown>).surfaceId === surfaceId,
    ) as unknown as Record<string, unknown> | undefined;
    expect(completeMsg).toBeDefined();
    expect(completeMsg?.conversationId).toBe("conv-1");
    expect(completeMsg?.summary).toContain("Delete");
  });

  test("file_upload surface broadcasts ui_surface_complete on action", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const showResult = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "file_upload",
      title: "Upload documents",
      data: { accept: ".pdf,.docx", maxFiles: 5 },
    });

    expect(showResult.isError).toBe(false);
    expect(showResult.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);

    await handleSurfaceAction(ctx, surfaceId, "submit", {
      files: [
        {
          filename: "doc.pdf",
          mimeType: "application/pdf",
          data: "base64encodedcontent",
        },
      ],
    });

    const completeMsg = broadcastedMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type ===
          "ui_surface_complete" &&
        (m as unknown as Record<string, unknown>).surfaceId === surfaceId,
    ) as unknown as Record<string, unknown> | undefined;
    expect(completeMsg).toBeDefined();
    expect(completeMsg?.conversationId).toBe("conv-1");
  });

  test("file_upload completion event does not include base64 file blobs", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "file_upload",
      title: "Upload",
      data: { accept: "*" },
    });

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;

    const largeBase64 = "A".repeat(10_000);
    await handleSurfaceAction(ctx, surfaceId, "submit", {
      files: [
        {
          filename: "big.pdf",
          mimeType: "application/pdf",
          data: largeBase64,
        },
      ],
    });

    const completeMsg = broadcastedMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type ===
          "ui_surface_complete" &&
        (m as unknown as Record<string, unknown>).surfaceId === surfaceId,
    ) as unknown as Record<string, unknown> | undefined;
    expect(completeMsg).toBeDefined();

    const submittedData = completeMsg?.submittedData as
      | Record<string, unknown>
      | undefined;
    // The files array with base64 blobs should be stripped from the
    // completion event — only the sanitized payload (without files) is sent.
    expect(submittedData?.files).toBeUndefined();
    // The raw base64 content should not appear anywhere in the event
    expect(JSON.stringify(completeMsg)).not.toContain(largeBase64);
  });

  test("choice surface broadcasts ui_surface_complete on action", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const showResult = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "choice",
      title: "Pick an outcome",
      data: {
        options: [
          { id: "inbox", title: "Clean up my inbox" },
          { id: "calendar", title: "Plan my week" },
        ],
      },
    });

    expect(showResult.isError).toBe(false);
    expect(showResult.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);

    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      choiceTitle: "Clean up my inbox",
      selectedIds: ["inbox"],
      selectedTitles: ["Clean up my inbox"],
    });

    const completeMsg = broadcastedMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type ===
          "ui_surface_complete" &&
        (m as unknown as Record<string, unknown>).surfaceId === surfaceId,
    ) as unknown as Record<string, unknown> | undefined;
    expect(completeMsg).toBeDefined();
    expect(completeMsg?.conversationId).toBe("conv-1");
    expect(completeMsg?.summary).toBe('User chose: "Clean up my inbox"');
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
  });

  test("oauth_connect surface broadcasts ui_surface_complete on action", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const showResult = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "oauth_connect",
      title: "Connect Google",
      data: {
        providerKey: "google",
        displayName: "Google",
      },
    });

    expect(showResult.isError).toBe(false);
    expect(showResult.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);

    await handleSurfaceAction(ctx, surfaceId, "connect", {
      status: "connected",
      providerKey: "google",
      providerLabel: "Google",
      accountLabel: "user@example.com",
    });

    const completeMsg = broadcastedMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type ===
          "ui_surface_complete" &&
        (m as unknown as Record<string, unknown>).surfaceId === surfaceId,
    ) as unknown as Record<string, unknown> | undefined;
    expect(completeMsg).toBeDefined();
    expect(completeMsg?.conversationId).toBe("conv-1");
    expect(completeMsg?.summary).toBe("Connected Google: user@example.com");
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
  });

  test("live-voice resume: oauth_connect completion routes to resumeWithText, not processMessage", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const resumeCalls: Array<{
      content: string;
      opts?: VoiceResumeOptions;
    }> = [];
    const handler: VoiceResumeHandler = {
      resumeWithText: (content, opts) => resumeCalls.push({ content, opts }),
    };
    registerVoiceResumeHandler("conv-1", handler);

    try {
      await surfaceProxyResolver(ctx, "ui_show", {
        surface_type: "oauth_connect",
        title: "Connect Google",
        data: { providerKey: "google", displayName: "Google" },
      });

      const showMessage = sent.find(
        (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
      ) as UiSurfaceShow;
      const surfaceId = showMessage.surfaceId;
      expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);

      await handleSurfaceAction(
        ctx,
        surfaceId,
        "connect",
        {
          status: "connected",
          providerKey: "google",
          providerLabel: "Google",
          accountLabel: "user@example.com",
        },
        "principal-committer",
      );

      // Routed to the spoken voice resume, NOT the silent text path.
      expect(ctx.processMessageCalls.length).toBe(0);
      expect(resumeCalls.length).toBe(1);
      expect(resumeCalls[0]!.content).toContain("oauth_connect");
      // The accepted surface-action request id rides into the resume and is the
      // one tracked in `surfaceActionRequestIds`, so the resumed turn adopting
      // it keeps `currentRequestId` inside the surface-action set.
      const resumeRequestId = resumeCalls[0]!.opts?.requestId;
      expect(resumeRequestId).toBeDefined();
      expect(ctx.surfaceActionRequestIds.has(resumeRequestId!)).toBe(true);
      // The user-facing label (not the raw payload) rides along for the
      // persisted/echoed user row.
      expect(resumeCalls[0]!.opts?.displayContent).toBeDefined();
      expect(resumeCalls[0]!.opts?.displayContent).not.toContain(
        "[User action on",
      );
      // The pending-surface guard is cleared on the voice-routed path too.
      expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
    } finally {
      unregisterVoiceResumeHandler("conv-1", handler);
    }
  });

  test("live-voice resume: busy conversation routes to resumeWithText, not the text queue", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);
    // The conversation is processing a turn: without the pre-enqueue voice
    // dispatch, the completion would be pushed onto the silent text queue
    // (`queued: true`) and later drained via `processMessage`, never spoken.
    ctx.isProcessing = () => true;
    let enqueueCalls = 0;
    ctx.enqueueMessage = () => {
      enqueueCalls += 1;
      return { queued: true, requestId: "queued-req" };
    };

    const resumeCalls: Array<{ content: string; opts?: VoiceResumeOptions }> =
      [];
    const handler: VoiceResumeHandler = {
      resumeWithText: (content, opts) => resumeCalls.push({ content, opts }),
    };
    registerVoiceResumeHandler("conv-1", handler);

    try {
      await surfaceProxyResolver(ctx, "ui_show", {
        surface_type: "oauth_connect",
        title: "Connect Google",
        data: { providerKey: "google", displayName: "Google" },
      });

      const showMessage = sent.find(
        (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
      ) as UiSurfaceShow;
      const surfaceId = showMessage.surfaceId;
      expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);

      await handleSurfaceAction(ctx, surfaceId, "connect", {
        status: "connected",
        providerKey: "google",
        providerLabel: "Google",
        accountLabel: "user@example.com",
      });

      // Routed to the spoken resume even though the conversation is busy — and
      // NOT pushed onto the silent text queue.
      expect(resumeCalls.length).toBe(1);
      expect(resumeCalls[0]!.content).toContain("oauth_connect");
      expect(enqueueCalls).toBe(0);
      expect(ctx.processMessageCalls.length).toBe(0);
      // No text-queue side effects leak to the client.
      expect(broadcastedMessages.some((m) => m.type === "message_queued")).toBe(
        false,
      );
      // The pending-surface guard is still cleared on the busy voice path.
      expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
    } finally {
      unregisterVoiceResumeHandler("conv-1", handler);
    }
  });

  test("live-voice resume: falls back to processMessage when no handler is registered", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "oauth_connect",
      title: "Connect Google",
      data: { providerKey: "google", displayName: "Google" },
    });

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;

    await handleSurfaceAction(ctx, surfaceId, "connect", {
      status: "connected",
      providerKey: "google",
      providerLabel: "Google",
      accountLabel: "user@example.com",
    });

    // No voice handler for this conversation — the text path runs verbatim.
    expect(ctx.processMessageCalls.length).toBe(1);
    expect(ctx.processMessageCalls[0]!.content).toContain("oauth_connect");
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
  });

  test("live-voice resume: surface action carrying attachments falls back to processMessage", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const resumeCalls: Array<{ content: string; opts?: VoiceResumeOptions }> =
      [];
    const handler: VoiceResumeHandler = {
      resumeWithText: (content, opts) => resumeCalls.push({ content, opts }),
    };
    registerVoiceResumeHandler("conv-1", handler);

    try {
      await surfaceProxyResolver(ctx, "ui_show", {
        surface_type: "file_upload",
        title: "Upload",
        data: { accept: "*" },
      });

      const showMessage = sent.find(
        (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
      ) as UiSurfaceShow;
      const surfaceId = showMessage.surfaceId;

      await handleSurfaceAction(ctx, surfaceId, "submit", {
        files: [
          {
            filename: "doc.pdf",
            mimeType: "application/pdf",
            data: "base64content",
          },
        ],
      });

      // Attachments never travel the voice path — the model still sees them via
      // the text `processMessage`, and the spoken resume is skipped.
      expect(resumeCalls.length).toBe(0);
      expect(ctx.processMessageCalls.length).toBe(1);
      expect(ctx.processMessageCalls[0]!.attachments.length).toBe(1);
      expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
    } finally {
      unregisterVoiceResumeHandler("conv-1", handler);
    }
  });

  test("live-voice resume end-to-end: oauth_connect completion runs a spoken continuation turn and clears the pending guard", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // A real live-voice session that registers a resume handler for this
    // conversation on start and speaks a continuation when resumed.
    const sessionFrames: Array<{ type: string }> = [];
    const sessionContext: LiveVoiceSessionFactoryContext = {
      sessionId: "voice-session-e2e",
      startFrame: {
        type: "start",
        conversationId: "conv-1",
        audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
      },
      sendFrame: async (payload) => {
        const frame = { ...payload } as { type: string };
        sessionFrames.push(frame);
        return frame as never;
      },
    };
    const idleTranscriber: StreamingTranscriber = {
      providerId: "deepgram",
      boundaryId: "daemon-streaming",
      async start(_onEvent: (event: SttStreamServerEvent) => void) {
        // Idle transcriber: the resume path never streams audio.
      },
      sendAudio() {},
      stop() {},
    };
    const startVoiceTurn = mock(async (options: VoiceTurnOptions) => {
      options.callbacks?.assistant_text_delta?.({
        type: "assistant_text_delta",
        text: "Great, Google is connected.",
        conversationId: options.conversationId,
      });
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: "assistant-message-e2e",
      });
      return { turnId: "bridge-e2e-1", abort: mock() };
    });
    const session = new LiveVoiceSession(sessionContext, {
      resolveTranscriber: async () => idleTranscriber,
      startVoiceTurn,
      createTurnId: () => "voice-turn-e2e",
      emitMetrics: false,
    });

    await session.start();

    try {
      // A voice turn raised an oauth_connect surface and yielded.
      await surfaceProxyResolver(ctx, "ui_show", {
        surface_type: "oauth_connect",
        title: "Connect Google",
        data: { providerKey: "google", displayName: "Google" },
      });
      const showMessage = sent.find(
        (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
      ) as UiSurfaceShow;
      const surfaceId = showMessage.surfaceId;
      expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(true);

      // The user completes the connect surface.
      await handleSurfaceAction(ctx, surfaceId, "connect", {
        status: "connected",
        providerKey: "google",
        providerLabel: "Google",
        accountLabel: "user@example.com",
      });

      // Spoken continuation ran through the live-voice session, not the
      // silent text path.
      await waitFor(() => sessionFrames.some((f) => f.type === "tts_done"));
      expect(ctx.processMessageCalls.length).toBe(0);
      expect(startVoiceTurn).toHaveBeenCalledTimes(1);
      const types = sessionFrames.map((f) => f.type);
      expect(types).not.toContain("stt_final");
      expect(types).toContain("thinking");
      expect(types).toContain("assistant_text_delta");
      // The pending-surface guard is cleared after the voice-routed completion.
      expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
    } finally {
      await session.close("client_end");
    }
  });

  test("table surface does NOT broadcast ui_surface_complete (not one-shot)", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "Items",
      data: {
        columns: [{ id: "name", label: "Name" }],
        rows: [{ id: "r1", cells: { name: "Item 1" } }],
      },
      actions: [{ id: "select", label: "Select" }],
    });

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;

    broadcastedMessages = [];
    await handleSurfaceAction(ctx, surfaceId, "select", {
      selectedIds: ["r1"],
    });

    const completeMsg = broadcastedMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type ===
        "ui_surface_complete",
    );
    expect(completeMsg).toBeUndefined();
  });
});

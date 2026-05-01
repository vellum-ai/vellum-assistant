import { describe, expect, test } from "bun:test";

import {
  createSurfaceMutex,
  handleSurfaceAction,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
} from "../daemon/message-protocol.js";
import type { UserMessageAttachment } from "../daemon/message-types/shared.js";

interface ProcessMessageCall {
  content: string;
  attachments: UserMessageAttachment[];
  requestId?: string;
  activeSurfaceId?: string;
  displayContent?: string;
}

function makeContext(sent: ServerMessage[] = []): SurfaceConversationContext & {
  processMessageCalls: ProcessMessageCall[];
} {
  const processMessageCalls: ProcessMessageCall[] = [];
  return {
    conversationId: "conv-1",
    traceEmitter: { emit: () => {} },
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
    processMessage: async (
      content: string,
      attachments: UserMessageAttachment[],
      _onEvent: (msg: ServerMessage) => void,
      requestId?: string,
      activeSurfaceId?: string,
      _currentPage?: string,
      _options?: { isInteractive?: boolean },
      displayContent?: string,
    ) => {
      processMessageCalls.push({
        content,
        attachments,
        requestId,
        activeSurfaceId,
        displayContent,
      });
      return "msg-1";
    },
    withSurface: createSurfaceMutex(),
    processMessageCalls,
  };
}

describe("surface action delivery to assistant", () => {
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
});

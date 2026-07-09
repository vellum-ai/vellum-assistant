import { describe, expect, test } from "bun:test";

import {
  createSurfaceMutex,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
  UiSurfaceShowWorkResult,
  WorkResultSurfaceData,
} from "../daemon/message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "../daemon/message-protocol.js";
import { uiShowTool } from "../tools/ui-surface/definitions.js";

function makeContext(sent: ServerMessage[] = []): SurfaceConversationContext {
  return {
    conversationId: "session-1",
    sendToClient: (msg) => sent.push(msg),
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
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  };
}

function getSurfaceTypeEnum(): string[] {
  return (
    uiShowTool.input_schema as {
      properties: { surface_type: { enum: string[] } };
    }
  ).properties.surface_type.enum;
}

describe("work_result surface protocol", () => {
  test("accepts the structured work result data shape", () => {
    const data: WorkResultSurfaceData = {
      eyebrow: "Moment 1 output",
      status: "partial",
      summary: "Archived low-signal mail and left two threads for review.",
      metrics: [
        { label: "Archived", value: 31, tone: "positive" },
        { label: "Skipped", value: 2, detail: "Needs review", tone: "warning" },
      ],
      sections: [
        {
          id: "attention",
          title: "Needs attention",
          type: "items",
          items: [
            {
              id: "contract",
              title: "Contract follow-up",
              description: "Needs a reply today.",
              status: "Reply today",
              tone: "warning",
              metadata: [{ label: "Mailbox", value: "Work" }],
            },
          ],
        },
        {
          id: "rewrite",
          title: "Important rewrite",
          type: "diff",
          diffs: [
            {
              label: "Executive ask",
              before: "Consider launching when ready.",
              after: "Approve a limited beta next week.",
            },
          ],
        },
      ],
    };

    const msg: UiSurfaceShowWorkResult = {
      type: "ui_surface_show",
      conversationId: "session-1",
      surfaceId: "surface-1",
      surfaceType: "work_result",
      title: "Inbox cleaned up",
      data,
    };

    expect(msg.surfaceType).toBe("work_result");
    expect(msg.data.metrics?.[0].value).toBe(31);
    expect(msg.data.sections?.[1].type).toBe("diff");
  });

  test("ui_show advertises work_result as display-only by default", () => {
    expect(getSurfaceTypeEnum()).toContain("work_result");
    expect(uiShowTool.description).toContain("work_result");
    expect(uiShowTool.description).toContain("structured receipt");
    expect(INTERACTIVE_SURFACE_TYPES).not.toContain("work_result");
  });

  test("ui_show can emit a work_result surface", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "work_result",
      title: "Inbox cleaned up",
      data: {
        status: "completed",
        summary: "Archived newsletters and surfaced reply threads.",
        metrics: [{ label: "Archived", value: 31, tone: "positive" }],
      },
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "work_result") return;

    expect(showMessage.title).toBe("Inbox cleaned up");
    expect(showMessage.data.summary).toBe(
      "Archived newsletters and surfaced reply threads.",
    );
    expect(showMessage.data.metrics?.[0]).toEqual({
      label: "Archived",
      value: 31,
      tone: "positive",
    });
    expect(ctx.pendingSurfaceActions.has(showMessage.surfaceId)).toBe(false);
  });
});

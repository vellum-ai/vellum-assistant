/**
 * Tests for `settleRunningTaskProgressSurfaces`: the turn-end floor that keeps
 * a task_progress card from spinning after the turn it belonged to is over.
 *
 * Covers:
 * - A card or step still `in_progress` becomes `pending`, via a real
 *   `ui_surface_update` and the stored surface state.
 * - Steps already `completed` or `failed` keep their status; nothing is
 *   promoted to `completed`.
 * - A card in a terminal state, a card with no running step, and non-card /
 *   non-task_progress surfaces are left untouched.
 * - A card from an earlier turn (absent from `currentTurnSurfaces`) is settled
 *   too; the settle is idempotent.
 */

import { describe, expect, test } from "bun:test";

import type pino from "pino";

import type { AssistantEvent } from "../api/index.js";
import type { Conversation } from "../daemon/conversation.js";
import {
  createSurfaceMutex,
  settleRunningTaskProgressSurfaces,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  CardSurfaceData,
  SurfaceType,
  UISurfaceUpdateEvent,
} from "../daemon/message-protocol.js";
import { asConversation } from "./helpers/mock-conversation.js";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as pino.Logger;

function makeContext(sent: AssistantEvent[] = []): Conversation {
  return asConversation({
    conversationId: "session-1",
    emit: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  });
}

async function showTaskProgress(
  ctx: Conversation,
  templateData: Record<string, unknown>,
): Promise<string> {
  const result = await surfaceProxyResolver(ctx, "ui_show", {
    surface_type: "card",
    title: "Working",
    data: { template: "task_progress", templateData },
  });
  expect(result.isError).toBe(false);
  return (JSON.parse(result.content as string) as { surfaceId: string })
    .surfaceId;
}

function updatesFor(sent: AssistantEvent[], surfaceId: string) {
  return sent.filter(
    (msg): msg is UISurfaceUpdateEvent =>
      msg.type === "ui_surface_update" && msg.surfaceId === surfaceId,
  );
}

function storedTemplateData(
  ctx: Conversation,
  surfaceId: string,
): Record<string, unknown> {
  const stored = ctx.surfaceState.get(surfaceId);
  if (!stored || stored.surfaceType !== "card") {
    throw new Error(`no stored card for ${surfaceId}`);
  }
  return (stored.data as CardSurfaceData).templateData as Record<
    string,
    unknown
  >;
}

describe("settleRunningTaskProgressSurfaces", () => {
  test("settles a running card and its running step to pending, keeping finished steps", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);
    const surfaceId = await showTaskProgress(ctx, {
      title: "Send the follow-up",
      status: "in_progress",
      steps: [
        { label: "Draft email", status: "completed" },
        { label: "Send to contact", status: "in_progress" },
        { label: "Log it", status: "pending" },
        { label: "Archive", status: "failed" },
      ],
    });

    settleRunningTaskProgressSurfaces(ctx, noopLogger);

    const updates = updatesFor(sent, surfaceId);
    expect(updates).toHaveLength(1);
    const templateData = (updates[0].data as CardSurfaceData)
      .templateData as Record<string, unknown>;
    expect(templateData.status).toBe("pending");
    expect(templateData.steps).toEqual([
      { label: "Draft email", status: "completed" },
      { label: "Send to contact", status: "pending" },
      { label: "Log it", status: "pending" },
      { label: "Archive", status: "failed" },
    ]);
    expect(storedTemplateData(ctx, surfaceId)).toEqual(templateData);
  });

  test("settles a running step under a card whose own status is already terminal", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);
    const surfaceId = await showTaskProgress(ctx, {
      status: "failed",
      steps: [{ label: "Only step", status: "in_progress" }],
    });

    settleRunningTaskProgressSurfaces(ctx, noopLogger);

    const templateData = storedTemplateData(ctx, surfaceId);
    expect(templateData.status).toBe("failed");
    expect(templateData.steps).toEqual([
      { label: "Only step", status: "pending" },
    ]);
  });

  test("leaves a card alone when nothing on it is running", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);
    const completed = await showTaskProgress(ctx, {
      status: "completed",
      steps: [{ label: "Done", status: "completed" }],
    });
    const parked = await showTaskProgress(ctx, {
      status: "pending",
      steps: [{ label: "Later", status: "pending" }],
    });
    sent.length = 0;

    settleRunningTaskProgressSurfaces(ctx, noopLogger);

    expect(updatesFor(sent, completed)).toHaveLength(0);
    expect(updatesFor(sent, parked)).toHaveLength(0);
    expect(storedTemplateData(ctx, parked).status).toBe("pending");
  });

  test("ignores surfaces that are not task_progress cards", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);
    const plainCard = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Note", body: "status: in_progress" },
    });
    const workResult = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "work_result",
      data: { status: "in_progress", summary: "Crunching" },
    });
    expect(plainCard.isError).toBe(false);
    expect(workResult.isError).toBe(false);
    sent.length = 0;

    settleRunningTaskProgressSurfaces(ctx, noopLogger);

    expect(sent.filter((msg) => msg.type === "ui_surface_update")).toHaveLength(
      0,
    );
  });

  test("settles a card shown on an earlier turn and is idempotent", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);
    const surfaceId = await showTaskProgress(ctx, {
      status: "in_progress",
      steps: [{ label: "Step", status: "in_progress" }],
    });
    // The prior turn's snapshot has been persisted and cleared.
    ctx.currentTurnSurfaces = [];
    sent.length = 0;

    settleRunningTaskProgressSurfaces(ctx, noopLogger);
    settleRunningTaskProgressSurfaces(ctx, noopLogger);

    expect(updatesFor(sent, surfaceId)).toHaveLength(1);
    const templateData = storedTemplateData(ctx, surfaceId);
    expect(templateData.status).toBe("pending");
    expect(templateData.steps).toEqual([{ label: "Step", status: "pending" }]);
  });

  test("a card shown with a pending status keeps it", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);
    const surfaceId = await showTaskProgress(ctx, {
      status: "pending",
      steps: [{ label: "Step", status: "pending" }],
    });

    expect(storedTemplateData(ctx, surfaceId).status).toBe("pending");
  });
});

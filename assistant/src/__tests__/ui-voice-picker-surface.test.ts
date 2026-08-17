/**
 * Tests for the `voice_picker` ui_show surface's "never blocks a turn"
 * invariant.
 *
 * The card has no terminal action: it settles when the user picks a voice,
 * with no button to click. `actions` and `await_action` are generic ui_show
 * params though, so the model can attach them to any surface, and the web
 * client latches `awaiting_user_input` on the presence of actions alone with
 * nothing to clear it. The daemon resolver therefore strips both, and a
 * pending picker never holds the one-interactive-surface lock.
 */

import { describe, expect, test } from "bun:test";

import { UISurfaceShowEventSchema } from "../api/events/ui-surface-show.js";
import type { AssistantEvent } from "../api/index.js";
import type { Conversation } from "../daemon/conversation.js";
import {
  createSurfaceMutex,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type { SurfaceType } from "../daemon/message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "../daemon/message-protocol.js";
import { asConversation } from "./helpers/mock-conversation.js";

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

function showEvent(sent: AssistantEvent[]) {
  return UISurfaceShowEventSchema.parse(
    sent.find((msg) => msg.type === "ui_surface_show"),
  );
}

describe("voice_picker never blocks a turn", () => {
  test("shows with an empty payload and awaits nothing", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "voice_picker",
      data: {},
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();

    const parsed = showEvent(sent);
    expect(parsed.surfaceType).toBe("voice_picker");
    expect(parsed.actions).toBeUndefined();
    expect(ctx.pendingSurfaceActions.has(parsed.surfaceId)).toBe(false);
  });

  test("strips actions the model attached", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "voice_picker",
      data: {},
      actions: [{ id: "done", label: "Done", style: "primary" }],
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();

    const parsed = showEvent(sent);
    expect(parsed.actions).toBeUndefined();
    // The persisted copy must match the emitted one, or a history reseed would
    // resurrect the button the client blocks on.
    expect(ctx.currentTurnSurfaces[0]?.actions).toBeUndefined();
    expect(ctx.pendingSurfaceActions.has(parsed.surfaceId)).toBe(false);
  });

  test("ignores an explicit await_action", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "voice_picker",
      data: {},
      await_action: true,
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();
    expect(result.content).not.toContain("awaiting_user_action");
    expect(ctx.pendingSurfaceActions.size).toBe(0);
  });

  test("a pending picker does not hold the one-interactive-surface lock", async () => {
    const ctx = makeContext();
    ctx.pendingSurfaceActions.set("surface-picker", {
      surfaceType: "voice_picker",
    });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "choice",
      data: { options: [{ id: "a", title: "Option A" }] },
    });

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("already awaiting user input");
  });

  test("voice_picker is not an interactive surface type", () => {
    expect(INTERACTIVE_SURFACE_TYPES).not.toContain("voice_picker");
  });
});

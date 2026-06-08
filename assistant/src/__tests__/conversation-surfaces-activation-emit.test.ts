import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Usage-data collection is enabled so recordActivationEvent writes rows.
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData: true }),
}));

let broadcastedMessages: ServerMessage[] = [];
const realEventHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...realEventHub,
  broadcastMessage: (msg: ServerMessage) => broadcastedMessages.push(msg),
}));

const { createSurfaceMutex, handleSurfaceAction, surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");

import type { SurfaceConversationContext } from "../daemon/conversation-surfaces.js";
import type { SurfaceType, UiSurfaceShow } from "../daemon/message-protocol.js";
import {
  isActivationSession,
  markActivationSession,
} from "../memory/activation-session-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { queryUnreportedOnboardingEvents } from "../memory/onboarding-events-store.js";
import { activationSessions, onboardingEvents } from "../memory/schema.js";

initializeDb();

interface ProcessMessageCall {
  content: string;
  activeSurfaceId?: string;
}

function makeContext(
  conversationId: string,
  sent: ServerMessage[] = [],
): SurfaceConversationContext & {
  processMessageCalls: ProcessMessageCall[];
} {
  const processMessageCalls: ProcessMessageCall[] = [];
  return {
    conversationId,
    traceEmitter: { emit: () => {} },
    sendToClient: (msg: ServerMessage) => sent.push(msg),
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
    processMessage: async (options) => {
      processMessageCalls.push({
        content: options.content,
        activeSurfaceId: options.activeSurfaceId,
      });
      return "msg-1";
    },
    withSurface: createSurfaceMutex(),
    processMessageCalls,
  } as SurfaceConversationContext & {
    processMessageCalls: ProcessMessageCall[];
  };
}

function resetTables(): void {
  getDb().delete(onboardingEvents).run();
  getDb().delete(activationSessions).run();
}

/** Render a choice surface tagged (or not) with an activation_moment. */
async function showTaggedChoice(
  ctx: SurfaceConversationContext,
  sent: ServerMessage[],
  activationMoment?: string,
): Promise<string> {
  await surfaceProxyResolver(ctx, "ui_show", {
    surface_type: "choice",
    title: "Pick an outcome",
    data: {
      options: [
        { id: "inbox", title: "Clean up my inbox" },
        { id: "calendar", title: "Plan my week" },
      ],
    },
    ...(activationMoment ? { activation_moment: activationMoment } : {}),
  });
  const showMessage = sent.find(
    (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
  ) as UiSurfaceShow;
  return showMessage.surfaceId;
}

describe("activation moment emission from ui_show surface commits", () => {
  beforeEach(() => {
    broadcastedMessages = [];
    resetTables();
  });

  test("committed tagged surface in a marked session writes exactly one row", async () => {
    markActivationSession("conv-marked");
    expect(isActivationSession("conv-marked")).toBe(true);

    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-marked", sent);
    const surfaceId = await showTaggedChoice(ctx, sent, "moment_2");

    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      selectedIds: ["inbox"],
    });

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_2_complete");
    expect(rows[0]!.stepIndex).toBe(2);
    expect(rows[0]!.sessionId).toBe("conv-marked");
  });

  test("does not forward the daemon-only tag to the client", async () => {
    markActivationSession("conv-marked-2");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-marked-2", sent);
    await showTaggedChoice(ctx, sent, "moment_2");

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    expect(
      (showMessage as unknown as Record<string, unknown>).activation_moment,
    ).toBeUndefined();
    expect(JSON.stringify(showMessage)).not.toContain("moment_2");
  });

  test("untagged surface writes no row", async () => {
    markActivationSession("conv-untagged");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-untagged", sent);
    const surfaceId = await showTaggedChoice(ctx, sent, undefined);

    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      selectedIds: ["inbox"],
    });

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("tagged surface in an UNMARKED session writes no row", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-not-rail", sent);
    const surfaceId = await showTaggedChoice(ctx, sent, "moment_2");

    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      selectedIds: ["inbox"],
    });

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("an invalid activation_moment token is ignored (no row)", async () => {
    markActivationSession("conv-bad-tag");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-bad-tag", sent);
    const surfaceId = await showTaggedChoice(ctx, sent, "bogus_moment");

    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      selectedIds: ["inbox"],
    });

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("intermediate selection_changed does NOT emit; the terminal commit does", async () => {
    markActivationSession("conv-table");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-table", sent);

    // A table surface stays pending across selection_changed (non-terminal).
    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "Tasks",
      data: {
        columns: [{ id: "name", label: "Name" }],
        rows: [
          { id: "r1", cells: { name: "Task 1" } },
          { id: "r2", cells: { name: "Task 2" } },
        ],
        selectionMode: "multiple",
      },
      actions: [{ id: "run", label: "Run", style: "primary" }],
      activation_moment: "moment_3",
    });
    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;

    // Intermediate, non-terminal — must NOT emit.
    await handleSurfaceAction(ctx, surfaceId, "selection_changed", {
      selectedIds: ["r1"],
    });
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);

    // Terminal commit — emits exactly once.
    await handleSurfaceAction(ctx, surfaceId, "run", { selectedIds: ["r1"] });
    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_3_complete");
  });
});

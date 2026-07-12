import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

// Analytics consent is granted so recordActivationEvent writes rows.
let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

let broadcastedMessages: ServerMessage[] = [];
const realEventHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...realEventHub,
  broadcastMessage: (msg: ServerMessage) => broadcastedMessages.push(msg),
}));

// Stub the child-conversation launcher so the launch_conversation commit path
// runs without spinning up a real conversation.
mock.module("../daemon/conversation-launch.js", () => ({
  launchConversation: async () => ({ conversationId: "spawned-conv" }),
}));

const { createSurfaceMutex, handleSurfaceAction, surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");

import type { SurfaceConversationContext } from "../daemon/conversation-surfaces.js";
import type { SurfaceType, UiSurfaceShow } from "../daemon/message-protocol.js";
import { queryUnreportedOnboardingEvents } from "../onboarding/onboarding-events-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  activationSessions,
  onboardingEvents,
} from "../persistence/schema/index.js";
import {
  isActivationSession,
  markActivationSession,
} from "../plugins/defaults/memory/activation-session-store.js";

await initializeDb();

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
    shareAnalytics = true;
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

  test("a queue-rejected commit does NOT emit; the tag survives for the retry", async () => {
    markActivationSession("conv-rejected");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-rejected", sent);
    const surfaceId = await showTaggedChoice(ctx, sent, "moment_2");

    // First click while the queue is full: enqueue rejects, action not
    // accepted. Must NOT record a milestone, and must leave the one-shot tag
    // intact so the user's retry still emits.
    ctx.enqueueMessage = () => ({
      queued: false,
      requestId: "req-rejected",
      rejected: true,
    });
    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      selectedIds: ["inbox"],
    });
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);

    // Retry is accepted → records exactly one row.
    ctx.enqueueMessage = () => ({ queued: false, requestId: "req-ok" });
    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      selectedIds: ["inbox"],
    });
    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_2_complete");
  });

  test("first_wow_executed records at SHOW time (no commit) and never double-emits", async () => {
    markActivationSession("conv-wow");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-wow", sent);

    // A display-only result surface tagged with the execution moment.
    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Inbox cleaned",
      data: { body: "Archived 1,240 emails" },
      activation_moment: "first_wow_executed",
    });

    // Recorded immediately on render — no handleSurfaceAction commit needed.
    let rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_first_wow_executed");
    expect(rows[0]!.stepIndex).toBe(4);

    // If the card later receives a commit (e.g. it carried an action), it must
    // NOT double-emit — a show-timing tag is never stored for the commit path.
    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    await handleSurfaceAction(ctx, showMessage.surfaceId, "expand", {});
    rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
  });

  test("first_wow_executed in an UNMARKED session writes no row at show time", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-wow-unmarked", sent);
    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Result",
      data: { body: "x" },
      activation_moment: "first_wow_executed",
    });
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
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

  test("FIX 1: launch_conversation commit on a tagged surface records exactly one row", async () => {
    markActivationSession("conv-launch");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-launch", sent);

    // A launcher card tagged with a commit-timing moment. The committed action
    // carries `_action: launch_conversation`, so handleSurfaceAction takes the
    // inline-launch branch (which previously returned before the emit).
    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Start something",
      data: { body: "Kick off a draft" },
      actions: [{ id: "go", label: "Go", style: "primary" }],
      activation_moment: "moment_1",
    });
    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    const surfaceId = showMessage.surfaceId;

    await handleSurfaceAction(ctx, surfaceId, "go", {
      _action: "launch_conversation",
      title: "Draft",
      seedPrompt: "Write a draft",
    });

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_1_complete");
    expect(rows[0]!.sessionId).toBe("conv-launch");
  });

  test("FIX 2: commit-timing tag survives a surfaceState restore from history", async () => {
    markActivationSession("conv-restore");
    const sent: ServerMessage[] = [];
    const ctx = makeContext("conv-restore", sent);
    const surfaceId = await showTaggedChoice(ctx, sent, "moment_2");

    // The daemon-only tag must NOT leak to the client.
    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    ) as UiSurfaceShow;
    expect(
      (showMessage as unknown as Record<string, unknown>).activation_moment,
    ).toBeUndefined();
    expect(JSON.stringify(showMessage)).not.toContain("moment_2");

    // Persist the surface into a history block exactly as the agent loop does
    // (conversation-agent-loop-handlers): copy the activationMoment through.
    const persisted = ctx.currentTurnSurfaces.map((s) => ({
      type: "ui_surface" as const,
      surfaceId: s.surfaceId,
      surfaceType: s.surfaceType,
      title: s.title,
      data: s.data,
      actions: s.actions,
      ...(s.activationMoment ? { activationMoment: s.activationMoment } : {}),
    }));
    expect(persisted[0]!.activationMoment).toBe("moment_2");

    // Simulate a reload: drop the in-memory surfaceState, then rebuild it from
    // the persisted history block the same way restoreSurfaceStateFromHistory
    // does (including rehydrating the daemon-only tag).
    ctx.surfaceState.clear();
    for (const b of persisted) {
      ctx.surfaceState.set(b.surfaceId, {
        surfaceType: b.surfaceType,
        data: b.data,
        title: b.title,
        actions: b.actions,
        ...(b.activationMoment ? { activationMoment: b.activationMoment } : {}),
      });
    }

    // A commit after restore still records exactly one row.
    await handleSurfaceAction(ctx, surfaceId, "inbox", {
      choiceId: "inbox",
      selectedIds: ["inbox"],
    });

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_2_complete");
    expect(rows[0]!.sessionId).toBe("conv-restore");
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

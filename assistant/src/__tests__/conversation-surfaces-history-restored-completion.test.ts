import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { UISurfaceCompleteEvent } from "../api/events/ui-surface-complete.js";
import type { AssistantEvent } from "../api/index.js";

let broadcastedMessages: AssistantEvent[] = [];
const realEventHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...realEventHub,
  broadcastMessage: (msg: AssistantEvent) => broadcastedMessages.push(msg),
}));

// Stand-in for the persisted message store: `getMessages` reads it and
// `updateMessageContent` writes back through JSON, so a read after a write
// sees exactly what a client's turn-end history reseed would fetch.
type StoredRow = {
  id: string;
  conversationId: string;
  role: string;
  content: Array<Record<string, unknown>>;
  createdAt: number;
  metadata: string | null;
};
let storedRows: StoredRow[] = [];
let contentWrites: Array<{
  id: string;
  blocks: Array<Record<string, unknown>>;
}> = [];

const realCrud = await import("../persistence/conversation-crud.js");
mock.module("../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getMessages: (conversationId: string) =>
    storedRows.filter((r) => r.conversationId === conversationId),
  updateMessageContent: (id: string, content: string) => {
    const blocks = JSON.parse(content) as Array<Record<string, unknown>>;
    contentWrites.push({ id, blocks });
    const row = storedRows.find((r) => r.id === id);
    if (row) {
      row.content = blocks;
    }
  },
}));

// Import must come AFTER mock.module so the surface module picks up the
// mocked event hub and persistence functions.
const { createSurfaceMutex, handleSurfaceAction } =
  await import("../daemon/conversation-surfaces.js");

import type { SurfaceConversationContext } from "../daemon/conversation-surfaces.js";
import type { SurfaceType } from "../daemon/message-protocol.js";

const CONVERSATION_ID = "conv-history-restored-1";

type EnqueueResult = { queued: boolean; requestId: string; rejected?: boolean };

function makeContext(
  enqueueResult: EnqueueResult = { queued: false, requestId: "req-1" },
): SurfaceConversationContext & { enqueuedContents: string[] } {
  const enqueuedContents: string[] = [];
  return {
    conversationId: CONVERSATION_ID,
    sendToClient: () => {},
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
    pendingStandaloneSurfaces: new Map(),
    recentlyCompletedStandaloneSurfaces: new Map(),
    isProcessing: () => false,
    enqueueMessage: (options) => {
      enqueuedContents.push(options.content);
      return enqueueResult;
    },
    getQueueDepth: () => 0,
    processMessage: async () => "msg-1",
    withSurface: createSurfaceMutex(),
    enqueuedContents,
  };
}

function seedSurfaceRow(surfaceId: string, surfaceType: string): void {
  storedRows = [
    {
      id: "msg-with-surface",
      conversationId: CONVERSATION_ID,
      role: "assistant",
      content: [
        { type: "text", text: "Which one?" },
        {
          type: "ui_surface",
          surfaceId,
          surfaceType,
          data: {
            options: [
              { id: "inbox", title: "Clean up my inbox" },
              { id: "calendar", title: "Plan my week" },
            ],
          },
        },
      ],
      createdAt: 0,
      metadata: null,
    },
  ];
}

/** Re-read the persisted block the way a history reseed would. */
function readPersistedSurface(
  surfaceId: string,
): Record<string, unknown> | undefined {
  for (const row of storedRows) {
    const block = row.content.find(
      (b) => b.type === "ui_surface" && b.surfaceId === surfaceId,
    );
    if (block) {
      return block;
    }
  }
  return undefined;
}

function completionBroadcasts(surfaceId: string): UISurfaceCompleteEvent[] {
  return broadcastedMessages.filter(
    (m): m is UISurfaceCompleteEvent =>
      m.type === "ui_surface_complete" && m.surfaceId === surfaceId,
  );
}

// The payload the web client posts when a user picks an option.
const CHOICE_PAYLOAD = {
  choiceId: "inbox",
  choiceTitle: "Clean up my inbox",
  selectedIds: ["inbox"],
  selectedTitles: ["Clean up my inbox"],
};

describe("history-restored surface completion", () => {
  beforeEach(() => {
    broadcastedMessages = [];
    contentWrites = [];
    storedRows = [];
  });

  test("one-shot choice surface with no in-memory state is completed and persisted", async () => {
    const surfaceId = "surface-choice-history-1";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();

    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
    expect(ctx.surfaceState.has(surfaceId)).toBe(false);

    // The history-restored branch signals acceptance by returning nothing; the
    // HTTP route maps that to `{ ok: true }`.
    const result = await handleSurfaceAction(
      ctx,
      surfaceId,
      "inbox",
      CHOICE_PAYLOAD,
    );
    expect(result).toBeUndefined();

    // The turn is still enqueued.
    expect(ctx.enqueuedContents).toHaveLength(1);

    // A re-read of persisted history reports the surface as answered, which is
    // exactly what the client's turn-end reseed fetches.
    const persisted = readPersistedSurface(surfaceId);
    expect(persisted?.completed).toBe(true);
    expect(persisted?.completionSummary).toBe(
      'User chose: "Clean up my inbox"',
    );

    const completions = completionBroadcasts(surfaceId);
    expect(completions).toHaveLength(1);
    expect(completions[0].summary).toBe('User chose: "Clean up my inbox"');
  });

  test("in-memory surface state supplies the type when it is still present", async () => {
    const surfaceId = "surface-choice-history-2";
    // Nothing persisted: the type can only come from the live entry.
    storedRows = [];
    const ctx = makeContext();
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "choice",
      data: {
        options: [{ id: "inbox", title: "Clean up my inbox" }],
        selectionMode: "single",
      },
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    const completions = completionBroadcasts(surfaceId);
    expect(completions).toHaveLength(1);
    expect(completions[0].summary).toBe('User chose: "Clean up my inbox"');
  });

  test("a non-one-shot persisted surface type is not auto-completed", async () => {
    const surfaceId = "surface-page-history-1";
    seedSurfaceRow(surfaceId, "dynamic_page");
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "answer_selected", {
      choiceId: "inbox",
    });

    expect(ctx.enqueuedContents).toHaveLength(1);
    expect(readPersistedSurface(surfaceId)?.completed).toBeUndefined();
    expect(contentWrites).toHaveLength(0);
    expect(completionBroadcasts(surfaceId)).toHaveLength(0);
  });

  test("a rejected enqueue leaves the surface answerable", async () => {
    const surfaceId = "surface-choice-history-3";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext({
      queued: false,
      requestId: "req-rejected",
      rejected: true,
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    expect(readPersistedSurface(surfaceId)?.completed).toBeUndefined();
    expect(contentWrites).toHaveLength(0);
    expect(completionBroadcasts(surfaceId)).toHaveLength(0);
    expect(ctx.surfaceActionRequestIds.size).toBe(0);
  });

  test("an explicit _completeSurface request completes a non-one-shot surface", async () => {
    const surfaceId = "surface-page-history-2";
    seedSurfaceRow(surfaceId, "dynamic_page");
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "answer_selected", {
      _completeSurface: true,
      _completionSummary: "Answered",
    });

    expect(readPersistedSurface(surfaceId)?.completed).toBe(true);
    expect(readPersistedSurface(surfaceId)?.completionSummary).toBe("Answered");
    const completions = completionBroadcasts(surfaceId);
    expect(completions).toHaveLength(1);
    expect(completions[0].summary).toBe("Answered");
  });

  test("the pending branch still completes a one-shot surface exactly as before", async () => {
    const surfaceId = "surface-choice-pending-1";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();
    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "choice" });
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "choice",
      data: {
        options: [
          { id: "inbox", title: "Clean up my inbox" },
          { id: "calendar", title: "Plan my week" },
        ],
        selectionMode: "single",
      },
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    expect(ctx.enqueuedContents).toHaveLength(1);
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
    expect(readPersistedSurface(surfaceId)?.completed).toBe(true);

    const completions = completionBroadcasts(surfaceId);
    expect(completions).toHaveLength(1);
    const completion = completions[0];
    expect(completion.summary).toBe('User chose: "Clean up my inbox"');
    // The pending branch carries the submitted payload on the broadcast.
    expect(completion.submittedData).toEqual(CHOICE_PAYLOAD);
  });
});

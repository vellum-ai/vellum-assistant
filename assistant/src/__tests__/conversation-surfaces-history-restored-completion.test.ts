import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { UISurfaceCompleteEvent } from "../api/events/ui-surface-complete.js";
import type { AssistantEvent } from "../api/index.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  createMockLoggerModule,
  makeMockLogger,
} from "./helpers/mock-logger.js";

/** Interleaved record of persist writes and broadcasts, for ordering asserts. */
let callOrder: string[] = [];

let broadcastedMessages: AssistantEvent[] = [];
const realEventHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...realEventHub,
  broadcastMessage: (msg: AssistantEvent) => {
    callOrder.push(`broadcast:${msg.type}`);
    broadcastedMessages.push(msg);
  },
}));

let loggedWarnings: Array<{ fields: Record<string, unknown>; msg: string }> =
  [];
mock.module("../util/logger.js", () =>
  createMockLoggerModule({
    getLogger: () => ({
      debug: () => {},
      info: () => {},
      warn: (fields: Record<string, unknown>, msg: string) =>
        loggedWarnings.push({ fields, msg }),
      error: () => {},
      fatal: () => {},
      trace: () => {},
      child: makeMockLogger,
    }),
  }),
);

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
/**
 * Full-history scans this action cost. `getMessages` is the dominant per-turn
 * main-thread cost on large conversations, so the counts are pinned.
 */
let getMessagesCalls = 0;
/** When set, every persisted write throws it, standing in for a SQLite lock. */
let persistError: Error | null = null;

const realCrud = await import("../persistence/conversation-crud.js");
mock.module("../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getMessages: (conversationId: string) => {
    getMessagesCalls++;
    // Fresh copies per call, like the real row mapper: a hit held across a
    // write must not alias the store.
    return storedRows
      .filter((r) => r.conversationId === conversationId)
      .map((r) => ({ ...r, content: structuredClone(r.content) }));
  },
  updateMessageContent: (id: string, content: string) => {
    if (persistError) {
      throw persistError;
    }
    const blocks = JSON.parse(content) as Array<Record<string, unknown>>;
    callOrder.push("persist");
    contentWrites.push({ id, blocks });
    const row = storedRows.find((r) => r.id === id);
    if (row) {
      row.content = blocks;
    }
  },
}));

function resetSurfaceState(): void {
  broadcastedMessages = [];
  contentWrites = [];
  storedRows = [];
  callOrder = [];
  loggedWarnings = [];
  getMessagesCalls = 0;
  persistError = null;
}

// Import must come AFTER mock.module so the surface module picks up the
// mocked event hub and persistence functions.
const {
  completeSurfaceAndNotify,
  createSurfaceMutex,
  handleSurfaceAction,
  markSurfaceCompleted,
  surfaceProxyResolver,
} = await import("../daemon/conversation-surfaces.js");

import type { Conversation } from "../daemon/conversation.js";
import type { SurfaceStateEntry } from "../daemon/conversation-surface-state.js";
import type { SurfaceType } from "../daemon/message-protocol.js";
import { asConversation } from "./helpers/mock-conversation.js";

const CONVERSATION_ID = "conv-history-restored-1";

/** The trust the surface-action route stamps on for a local guardian caller. */
const GUARDIAN_TRUST: TrustContext = {
  trustClass: "guardian",
  sourceChannel: "vellum",
};

type EnqueueResult = { queued: boolean; requestId: string; rejected?: boolean };

function makeContext(
  enqueueResult: EnqueueResult = { queued: false, requestId: "req-1" },
  overrides: {
    trustContext?: TrustContext;
    queueDepth?: number;
    emit?: (msg: AssistantEvent) => void;
  } = {},
): Conversation & { enqueuedContents: string[] } {
  const enqueuedContents: string[] = [];
  return asConversation({
    conversationId: CONVERSATION_ID,
    trustContext: overrides.trustContext ?? GUARDIAN_TRUST,
    emit: overrides.emit ?? (() => {}),
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
    getQueueDepth: () => overrides.queueDepth ?? 0,
    processMessage: async () => "msg-1",
    withSurface: createSurfaceMutex(),
    enqueuedContents,
  });
}

function seedSurfaceRow(
  surfaceId: string,
  surfaceType: string,
  metadata: string | null = null,
): void {
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
      metadata,
    },
  ];
}

function seedConfirmationRow(
  surfaceId: string,
  data: Record<string, unknown>,
): void {
  storedRows = [
    {
      id: "msg-with-confirmation",
      conversationId: CONVERSATION_ID,
      role: "assistant",
      content: [
        { type: "text", text: "Are you sure?" },
        { type: "ui_surface", surfaceId, surfaceType: "confirmation", data },
      ],
      createdAt: 0,
      metadata: null,
    },
  ];
}

/**
 * Re-read the persisted block the way a history reseed would. Newest row
 * first, matching the production scan.
 */
function readPersistedSurface(
  surfaceId: string,
): Record<string, unknown> | undefined {
  for (let i = storedRows.length - 1; i >= 0; i--) {
    const block = storedRows[i].content.find(
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
  beforeEach(resetSurfaceState);

  test("one-shot choice surface with no in-memory state is completed and persisted", async () => {
    const surfaceId = "surface-choice-history-1";
    seedSurfaceRow(surfaceId, "choice");
    // Neither live map holds anything, so the type can only come from history.
    const ctx = makeContext();

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

  test("a history-restored confirmation quotes its persisted confirmLabel", async () => {
    const surfaceId = "surface-confirm-history-1";
    seedConfirmationRow(surfaceId, {
      message: "Delete this project?",
      confirmLabel: "Delete forever",
      cancelLabel: "Keep it",
    });
    // Neither live map holds anything, so the labels come from history.
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "confirm", {});

    expect(readPersistedSurface(surfaceId)?.completionSummary).toBe(
      'User chose: "Delete forever"',
    );
    const completions = completionBroadcasts(surfaceId);
    expect(completions).toHaveLength(1);
    expect(completions[0].summary).toBe('User chose: "Delete forever"');
  });

  test("a history-restored confirmation quotes its persisted cancelLabel", async () => {
    const surfaceId = "surface-confirm-history-2";
    seedConfirmationRow(surfaceId, {
      message: "Delete this project?",
      confirmLabel: "Delete forever",
      cancelLabel: "Keep it",
    });
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "cancel", {});

    expect(readPersistedSurface(surfaceId)?.completionSummary).toBe(
      'User chose: "Keep it"',
    );
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

  test("the pending branch completes a one-shot surface too", async () => {
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

  test("the history-restored branch carries the submitted payload too", async () => {
    const surfaceId = "surface-choice-history-4";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    expect(completionBroadcasts(surfaceId)[0].submittedData).toEqual(
      CHOICE_PAYLOAD,
    );
  });

  test("the completion omits submittedData entirely when there is none", async () => {
    const surfaceId = "surface-confirm-history-3";
    seedConfirmationRow(surfaceId, { message: "Delete?" });
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "confirm");

    expect(completionBroadcasts(surfaceId)[0]).not.toHaveProperty(
      "submittedData",
    );
  });

  test("the completion is persisted before it is broadcast", async () => {
    const surfaceId = "surface-choice-history-5";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    // A broadcast that outran a failed persist would leave the client showing
    // a completed card the next reseed reverts.
    expect(callOrder).toEqual(["persist", "broadcast:ui_surface_complete"]);
  });
});

describe("history-restored surface completion: requester provenance", () => {
  beforeEach(resetSurfaceState);

  test("the type-driven rule does not read a guardian-provenance surface for an untrusted requester", async () => {
    const surfaceId = "surface-choice-guardian-1";
    seedSurfaceRow(
      surfaceId,
      "choice",
      JSON.stringify({ provenanceTrustClass: "guardian" }),
    );
    const ctx = makeContext(undefined, {
      trustContext: { trustClass: "unknown", sourceChannel: "vellum" },
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    // The live path hides this row from this actor, so the persisted fallback
    // must not hand back its type or its labels. The filter covers that read
    // only: an explicit `_completeSurface` request skips it, and the write
    // scan is unfiltered.
    expect(readPersistedSurface(surfaceId)?.completed).toBeUndefined();
    expect(contentWrites).toHaveLength(0);
    expect(completionBroadcasts(surfaceId)).toHaveLength(0);
  });

  test("an untrusted requester completes a contact-provenance surface", async () => {
    const surfaceId = "surface-choice-contact-1";
    seedSurfaceRow(
      surfaceId,
      "choice",
      JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
    );
    const ctx = makeContext(undefined, {
      trustContext: { trustClass: "unknown", sourceChannel: "vellum" },
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    expect(readPersistedSurface(surfaceId)?.completed).toBe(true);
    expect(completionBroadcasts(surfaceId)).toHaveLength(1);
  });
});

describe("history-restored surface completion: scan cost", () => {
  beforeEach(resetSurfaceState);

  test("a one-shot action with no live state costs two full scans", async () => {
    const surfaceId = "surface-scan-1";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    // One read to resolve the type and the labels, then the write's own scan.
    // The write scans unfiltered while the read is provenance-filtered, so
    // each resolves its own row rather than sharing one.
    expect(getMessagesCalls).toBe(2);
    expect(readPersistedSurface(surfaceId)?.completed).toBe(true);
  });

  test("an explicit completion request with no live state costs one full scan", async () => {
    const surfaceId = "surface-scan-2";
    seedSurfaceRow(surfaceId, "dynamic_page");
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "answer_selected", {
      _completeSurface: true,
      _completionSummary: "Answered",
    });

    // The request carries its own summary, so only the write scans.
    expect(getMessagesCalls).toBe(1);
    expect(readPersistedSurface(surfaceId)?.completionSummary).toBe("Answered");
  });

  test("a non-one-shot action with live state costs no scan at all", async () => {
    const surfaceId = "surface-scan-3";
    seedSurfaceRow(surfaceId, "dynamic_page");
    const ctx = makeContext();
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "dynamic_page",
      data: { html: "<p>page</p>" },
    });

    await handleSurfaceAction(ctx, surfaceId, "answer_selected", {
      choiceId: "inbox",
    });

    expect(getMessagesCalls).toBe(0);
    expect(completionBroadcasts(surfaceId)).toHaveLength(0);
  });

  test("a non-one-shot action with no live state costs one decisive scan", async () => {
    const surfaceId = "surface-scan-4";
    seedSurfaceRow(surfaceId, "dynamic_page");
    const ctx = makeContext();

    await handleSurfaceAction(ctx, surfaceId, "answer_selected", {
      choiceId: "inbox",
    });

    // The persisted type is the only thing that can rule out completion here,
    // so this read is the decision input, not a discarded one.
    expect(getMessagesCalls).toBe(1);
    expect(completionBroadcasts(surfaceId)).toHaveLength(0);
    expect(contentWrites).toHaveLength(0);
  });

  test("a rejected action scans nothing", async () => {
    const surfaceId = "surface-scan-5";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext({
      queued: false,
      requestId: "req-rejected",
      rejected: true,
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    expect(getMessagesCalls).toBe(0);
  });

  test("a pending one-shot action costs one full scan", async () => {
    const surfaceId = "surface-scan-6";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();
    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "choice" });
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "choice",
      data: {
        options: [{ id: "inbox", title: "Clean up my inbox" }],
        selectionMode: "single",
      },
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    // The pending entry supplies the type, so only the write scans.
    expect(getMessagesCalls).toBe(1);
    expect(readPersistedSurface(surfaceId)?.completed).toBe(true);
  });
});

describe("surface action queue rejection", () => {
  beforeEach(resetSurfaceState);

  test("a rejected history-restored action is logged with queue depth", async () => {
    const surfaceId = "surface-rejected-1";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext(
      { queued: false, requestId: "req-rejected", rejected: true },
      { queueDepth: 7 },
    );

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    const rejection = loggedWarnings.find((w) =>
      w.msg.startsWith("Surface action rejected by the message queue"),
    );
    expect(rejection).toBeDefined();
    expect(rejection?.fields).toMatchObject({
      conversationId: CONVERSATION_ID,
      surfaceId,
      actionId: "inbox",
      queueDepth: 7,
    });
  });

  test("a rejected pending action is logged with queue depth", async () => {
    const surfaceId = "surface-rejected-2";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext(
      { queued: false, requestId: "req-rejected", rejected: true },
      { queueDepth: 3 },
    );
    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "choice" });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    const rejection = loggedWarnings.find((w) =>
      w.msg.startsWith("Surface action rejected by the message queue"),
    );
    expect(rejection?.fields).toMatchObject({
      surfaceId,
      actionId: "inbox",
      surfaceType: "choice",
      queueDepth: 3,
    });
    expect(completionBroadcasts(surfaceId)).toHaveLength(0);
  });
});

describe("surfaces completed without ever awaiting an action", () => {
  beforeEach(resetSurfaceState);

  test("a one-shot surface shown with await_action false completes on its first action", async () => {
    const ctx = makeContext();

    const shown = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "choice",
      await_action: false,
      title: "Pick one",
      data: {
        options: [
          { id: "inbox", title: "Clean up my inbox" },
          { id: "calendar", title: "Plan my week" },
        ],
      },
    });
    expect(shown.isError).toBe(false);
    const { surfaceId } = JSON.parse(shown.content) as { surfaceId: string };

    // `ui_show` registers no pending entry when it is not awaiting an action,
    // so the action lands on the no-pending branch.
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);
    expect(ctx.surfaceState.has(surfaceId)).toBe(true);

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    const completions = completionBroadcasts(surfaceId);
    expect(completions).toHaveLength(1);
    expect(completions[0].summary).toBe('User chose: "Clean up my inbox"');
  });

  test("a retried action after a pending completion completes the surface again", async () => {
    const surfaceId = "surface-retry-1";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();
    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "choice" });
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "choice",
      data: {
        options: [{ id: "inbox", title: "Clean up my inbox" }],
        selectionMode: "single",
      },
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);
    // The pending entry is consumed, but `surfaceState` survives, so a
    // duplicate POST re-runs the completion instead of being dropped.
    expect(ctx.pendingSurfaceActions.has(surfaceId)).toBe(false);

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    expect(completionBroadcasts(surfaceId)).toHaveLength(2);
    expect(contentWrites).toHaveLength(2);
    expect(readPersistedSurface(surfaceId)?.completed).toBe(true);
  });
});

describe("markSurfaceCompleted in-memory patching", () => {
  beforeEach(resetSurfaceState);

  test("marks only the newest in-memory copy of a duplicated surfaceId", () => {
    const surfaceId = "surface-duplicated-1";
    const older = { type: "ui_surface", surfaceId } as Record<string, unknown>;
    const newer = { type: "ui_surface", surfaceId } as Record<string, unknown>;
    const messages = [{ content: [older] }, { content: [newer] }];

    markSurfaceCompleted(
      { conversationId: CONVERSATION_ID, messages },
      surfaceId,
      "Done",
    );

    // The DB half patches the newest row only; marking every in-memory copy
    // would make a reseed revert the extras.
    expect(newer.completed).toBe(true);
    expect(newer.completionSummary).toBe("Done");
    expect(older.completed).toBeUndefined();
  });

  test("leaves in-memory messages pending when the persisted write throws", () => {
    const surfaceId = "surface-rollback-1";
    seedSurfaceRow(surfaceId, "choice");
    const block = { type: "ui_surface", surfaceId } as Record<string, unknown>;
    persistError = new Error("database is locked");

    expect(
      markSurfaceCompleted(
        { conversationId: CONVERSATION_ID, messages: [{ content: [block] }] },
        surfaceId,
        "Done",
      ),
    ).toBe(false);

    // A patched in-memory block over a pending DB row is the same divergence
    // the completion write exists to close.
    expect(block.completed).toBeUndefined();
    expect(block.completionSummary).toBeUndefined();
    expect(readPersistedSurface(surfaceId)?.completed).toBeUndefined();
  });

  test("patches in-memory messages when there is no persisted block to write", () => {
    const surfaceId = "surface-memory-only-1";
    const block = { type: "ui_surface", surfaceId } as Record<string, unknown>;

    expect(
      markSurfaceCompleted(
        { conversationId: CONVERSATION_ID, messages: [{ content: [block] }] },
        surfaceId,
        "Done",
      ),
    ).toBe(true);

    expect(block.completed).toBe(true);
    expect(block.completionSummary).toBe("Done");
  });
});

describe("completion summary sourcing", () => {
  beforeEach(resetSurfaceState);

  test("keeps live surface data when the persisted block carries none", async () => {
    const surfaceId = "surface-live-data-1";
    storedRows = [
      {
        id: "msg-typed-dataless",
        conversationId: CONVERSATION_ID,
        role: "assistant",
        content: [
          { type: "ui_surface", surfaceId, surfaceType: "confirmation" },
        ],
        createdAt: 0,
        metadata: null,
      },
    ];
    const ctx = makeContext();
    // `liveSurfaceType` and `liveSurfaceData` are independent inputs, so live
    // labels must survive a persisted read that only resolves the type.
    ctx.surfaceState.set(surfaceId, {
      data: { message: "Delete it?", confirmLabel: "Delete forever" },
    } as unknown as SurfaceStateEntry);

    await handleSurfaceAction(ctx, surfaceId, "confirm", {});

    expect(completionBroadcasts(surfaceId)[0].summary).toBe(
      'User chose: "Delete forever"',
    );
  });
});

/** The live entries a `ui_dismiss` with a recorded action tears down. */
function seedAnsweredSurface(ctx: Conversation, surfaceId: string): void {
  ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "choice" });
  ctx.lastSurfaceAction.set(surfaceId, {
    actionId: "inbox",
    data: CHOICE_PAYLOAD,
  });
  ctx.surfaceState.set(surfaceId, {
    surfaceType: "choice",
    data: {
      options: [{ id: "inbox", title: "Clean up my inbox" }],
      selectionMode: "single",
    },
  });
  ctx.surfaceUndoStacks.set(surfaceId, ["{}"]);
  ctx.accumulatedSurfaceState.set(surfaceId, { selectedIds: ["inbox"] });
}

function liveSurfaceKeysRemaining(
  ctx: Conversation,
  surfaceId: string,
): string[] {
  return (
    [
      ["pendingSurfaceActions", ctx.pendingSurfaceActions],
      ["lastSurfaceAction", ctx.lastSurfaceAction],
      ["surfaceState", ctx.surfaceState],
      ["surfaceUndoStacks", ctx.surfaceUndoStacks],
      ["accumulatedSurfaceState", ctx.accumulatedSurfaceState],
    ] as const
  )
    .filter(([, map]) => map.has(surfaceId))
    .map(([name]) => name);
}

describe("surface completion when the persisted write does not land", () => {
  beforeEach(resetSurfaceState);

  test("a completion whose write throws is not broadcast", async () => {
    const surfaceId = "surface-persist-throws-1";
    seedSurfaceRow(surfaceId, "choice");
    const ctx = makeContext();
    persistError = new Error("database is locked");

    const result = await handleSurfaceAction(
      ctx,
      surfaceId,
      "inbox",
      CHOICE_PAYLOAD,
    );

    // A persistence hiccup must not fail the action or drop the user's turn.
    expect(result).toBeUndefined();
    expect(ctx.enqueuedContents).toHaveLength(1);

    // The persisted block is still pending, so a client told the card was
    // completed would watch the next reseed revert it.
    expect(readPersistedSurface(surfaceId)?.completed).toBeUndefined();
    expect(completionBroadcasts(surfaceId)).toHaveLength(0);
  });

  test("a completion with no persisted block is still broadcast", async () => {
    const surfaceId = "surface-no-persisted-block-1";
    // Nothing in history: the write is a no-op because there is nothing to
    // write, and nothing can revert the client's completed card.
    const ctx = makeContext();
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "choice",
      data: {
        options: [{ id: "inbox", title: "Clean up my inbox" }],
        selectionMode: "single",
      },
    });

    await handleSurfaceAction(ctx, surfaceId, "inbox", CHOICE_PAYLOAD);

    expect(readPersistedSurface(surfaceId)).toBeUndefined();
    expect(contentWrites).toHaveLength(0);
    expect(completionBroadcasts(surfaceId)).toHaveLength(1);
  });

  test("a guardian card withdrawal is announced even when its write throws", () => {
    const surfaceId = "surface-withdrawn-1";
    seedSurfaceRow(surfaceId, "confirmation");
    persistError = new Error("database is locked");

    completeSurfaceAndNotify(CONVERSATION_ID, surfaceId, "Approved");

    // The request is already resolved, so withholding the announcement would
    // strand a live, clickable approval card for a decided request.
    expect(readPersistedSurface(surfaceId)?.completed).toBeUndefined();
    const completions = completionBroadcasts(surfaceId);
    expect(completions).toHaveLength(1);
    expect(completions[0].summary).toBe("Approved");
  });

  test("a ui_dismiss completion whose write throws stays retryable", async () => {
    const surfaceId = "surface-dismiss-persist-throws-1";
    seedSurfaceRow(surfaceId, "choice");
    const sentToClient: AssistantEvent[] = [];
    const ctx = makeContext(undefined, {
      emit: (msg) => {
        sentToClient.push(msg);
      },
    });
    seedAnsweredSurface(ctx, surfaceId);
    persistError = new Error("database is locked");

    const result = await surfaceProxyResolver(ctx, "ui_dismiss", {
      surface_id: surfaceId,
    });

    // Claiming success would have the model treat a card the next reseed
    // restores as gone, inviting a duplicate action.
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("completed");
    expect(
      sentToClient.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(0);
    expect(readPersistedSurface(surfaceId)?.completed).toBeUndefined();

    // Everything a retry needs survives.
    expect(liveSurfaceKeysRemaining(ctx, surfaceId)).toEqual([
      "pendingSurfaceActions",
      "lastSurfaceAction",
      "surfaceState",
      "surfaceUndoStacks",
      "accumulatedSurfaceState",
    ]);
  });

  test("a ui_dismiss completion that lands clears the live state", async () => {
    const surfaceId = "surface-dismiss-persist-lands-1";
    seedSurfaceRow(surfaceId, "choice");
    const sentToClient: AssistantEvent[] = [];
    const ctx = makeContext(undefined, {
      emit: (msg) => {
        sentToClient.push(msg);
      },
    });
    seedAnsweredSurface(ctx, surfaceId);

    const result = await surfaceProxyResolver(ctx, "ui_dismiss", {
      surface_id: surfaceId,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Surface completed");
    expect(
      sentToClient.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(1);
    expect(readPersistedSurface(surfaceId)?.completed).toBe(true);
    expect(liveSurfaceKeysRemaining(ctx, surfaceId)).toEqual([]);
  });

  test("a ui_dismiss with no recorded action clears the live state even when the write throws", async () => {
    const surfaceId = "surface-dismiss-no-action-1";
    seedSurfaceRow(surfaceId, "card");
    const sentToClient: AssistantEvent[] = [];
    const ctx = makeContext(undefined, {
      emit: (msg) => {
        sentToClient.push(msg);
      },
    });
    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "card" });
    ctx.surfaceState.set(surfaceId, { surfaceType: "card", data: {} });
    persistError = new Error("database is locked");

    const result = await surfaceProxyResolver(ctx, "ui_dismiss", {
      surface_id: surfaceId,
    });

    // The passive-dismiss branch owns its own persistence and drops the card
    // outright, so the completion gate must not hold its cleanup back.
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Surface dismissed");
    expect(
      sentToClient.filter((m) => m.type === "ui_surface_dismiss"),
    ).toHaveLength(1);
    expect(liveSurfaceKeysRemaining(ctx, surfaceId)).toEqual([]);
  });
});

/**
 * Tests for `assistant-reply-producer.ts`: which finished replies earn a push,
 * and the shape of the signal the qualifying ones emit.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { MESSAGE_KEYS } from "../../i18n/index.js";
import type { AttentionState } from "../../persistence/conversation-attention-store.js";
import type {
  ConversationRow,
  MessageRow,
} from "../../persistence/conversation-crud.js";
import {
  MEMORY_V2_CONSOLIDATION_SOURCE,
  resolveConversationKind,
} from "../../persistence/conversation-types.js";
import type { ContentBlock } from "../../providers/types.js";
import { NOTIFICATION_TITLE_MAX_LENGTH } from "../notification-utils.js";

// ── Module mocks ───────────────────────────────────────────────────────
//
// `mock.module` is hoisted, so these intercepts apply before the module under
// test resolves its imports. Each test rewrites the module-scoped fixtures
// below and inspects the captured emit calls afterwards.

const emitCalls: any[] = [];
const messageLookups: string[] = [];
let conversationRow: ConversationRow | null = null;
let assistantRow: MessageRow | null = null;
let initiatingRow: MessageRow | null = null;
let attentionState: AttentionState | null = null;
let getConversationShouldThrow = false;
let pendingBackgroundWork = false;
let pendingWorkStartedAt: number | undefined;
let firstAssistantRow: MessageRow | null = null;
let persistedRows: MessageRow[] | undefined;
const recentHistoryPages: Array<string | undefined> = [];
const pendingWorkArgs: unknown[][] = [];

mock.module("../has-pending-background-work.js", () => ({
  hasPendingBackgroundWork: (...args: unknown[]) => {
    pendingWorkArgs.push(args);
    if (pendingWorkStartedAt !== undefined) {
      return (
        pendingWorkStartedAt >=
        (args[1] as { startedAfter: number }).startedAfter
      );
    }
    return pendingBackgroundWork;
  },
}));

mock.module("../emit-signal.js", () => ({
  emitNotificationSignal: async (params: any) => {
    emitCalls.push(params);
    return {
      signalId: "sig-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
}));

const CONVERSATION_ID = "conv-1";
const ASSISTANT_MESSAGE_ID = "msg-assistant-1";
const USER_MESSAGE_ID = "msg-user-1";

const realCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getConversation: () => {
    if (getConversationShouldThrow) {
      throw new Error("simulated conversation lookup failure");
    }
    return conversationRow;
  },
  getMessageById: (messageId: string) => {
    messageLookups.push(messageId);
    if (firstAssistantRow?.id === messageId) {
      return firstAssistantRow;
    }
    const persisted = persistedRows?.find((row) => row.id === messageId);
    if (persisted) {
      return persisted;
    }
    return messageId === ASSISTANT_MESSAGE_ID ? assistantRow : initiatingRow;
  },
  getRecentConversationMessages: (
    _conversationId: string,
    limit: number,
    beforeMessageId?: string,
  ) => {
    recentHistoryPages.push(beforeMessageId);
    const history =
      persistedRows ??
      [initiatingRow, firstAssistantRow, assistantRow].filter(
        (row): row is MessageRow => row !== null,
      );
    const end = beforeMessageId
      ? history.findIndex((row) => row.id === beforeMessageId)
      : history.length;
    return history.slice(Math.max(0, end - limit), end);
  },
}));

// Attachments the assistant row carries. Linked by the agent loop before the
// producer runs, and exposed separately from the row's content blocks.
let assistantAttachments: Array<{ originalFilename: string }> = [];
const attachmentLookups: string[] = [];
const realAttachmentsStore =
  await import("../../persistence/attachments-store.js");
mock.module("../../persistence/attachments-store.js", () => ({
  ...realAttachmentsStore,
  getAttachmentMetadataForMessage: (messageId: string) => {
    attachmentLookups.push(messageId);
    return assistantAttachments;
  },
}));

let guardianPrincipalId: string | undefined = "guardian-1";
let guardianLookupGate: Promise<void> | undefined;
let onGuardianLookup = () => {};
const realGuardianDelivery =
  await import("../../contacts/guardian-delivery-reader.js");
mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  ...realGuardianDelivery,
  getGuardianDelivery: async () => {
    onGuardianLookup();
    if (guardianLookupGate) {
      await guardianLookupGate;
    }
    return guardianPrincipalId
      ? [
          {
            channelType: "vellum",
            status: "active",
            principalId: guardianPrincipalId,
          },
        ]
      : null;
  },
}));

// Defaults to unattended, so every other case in this file exercises the
// unsuppressed path.
let desktopAttended = false;
let desktopPresenceShouldThrow = false;
const desktopPresenceArgs: unknown[][] = [];
const realDesktopPresence = await import("../../runtime/desktop-presence.js");
mock.module("../../runtime/desktop-presence.js", () => ({
  ...realDesktopPresence,
  isDesktopAttended: (...args: unknown[]) => {
    desktopPresenceArgs.push(args);
    if (desktopPresenceShouldThrow) {
      throw new Error("simulated presence read failure");
    }
    return desktopAttended;
  },
}));

// Defaults to unfocused, so every other case in this file exercises the
// unsuppressed path.
let webFocused = false;
let webPresenceShouldThrow = false;
const webPresenceArgs: unknown[][] = [];
const realWebPresence = await import("../../runtime/web-presence.js");
mock.module("../../runtime/web-presence.js", () => ({
  ...realWebPresence,
  isWebConversationFocused: (...args: unknown[]) => {
    webPresenceArgs.push(args);
    if (webPresenceShouldThrow) {
      throw new Error("simulated presence read failure");
    }
    return webFocused;
  },
}));

const realAttentionStore =
  await import("../../persistence/conversation-attention-store.js");
mock.module("../../persistence/conversation-attention-store.js", () => ({
  ...realAttentionStore,
  getAttentionStateByConversationIds: (ids: string[]) => {
    const map = new Map<string, AttentionState>();
    if (attentionState) {
      map.set(ids[0], attentionState);
    }
    return map;
  },
}));

const { emitAssistantReplyNotification } =
  await import("../assistant-reply-producer.js");

// ── Fixtures ───────────────────────────────────────────────────────────

function makeConversation(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  return {
    id: CONVERSATION_ID,
    title: "Weekend plans",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    historyStrippedAt: null,
    slackContextCompactionWatermarkTs: null,
    slackContextCompactionWatermarkAt: null,
    conversationType: "chat",
    source: "user",
    originChannel: null,
    originInterface: null,
    forkParentConversationId: null,
    forkParentMessageId: null,
    forkStrategy: null,
    isAutoTitle: 0,
    scheduleJobId: null,
    lastMessageAt: null,
    archivedAt: null,
    surfacedAt: null,
    inferenceProfile: null,
    enabledPlugins: null,
    inferenceProfileSessionId: null,
    inferenceProfileExpiresAt: null,
    lastNotifiedInferenceProfile: null,
    processingStartedAt: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: USER_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    role: "user",
    content: [{ type: "text", text: "hello" }] as ContentBlock[],
    createdAt: 1700000000100,
    metadata: null,
    clientMessageId: null,
    finalized: 1,
    ...overrides,
  };
}

/**
 * A turn opened from the macOS app. The `client` bag's `os` entry is the only
 * per-platform attribution: the interface stamp is "web" for the macOS app,
 * the iOS app, and a desktop browser alike. `clientOsFromRequest` says the
 * send itself reported that OS, which is what separates it from a row that
 * inherited the conversation's live client state.
 */
function makeMacOriginatedMessage(): MessageRow {
  return makeMessage({
    metadata: JSON.stringify({
      userMessageChannel: "vellum",
      userMessageInterface: "web",
      client: { os: "macos" },
      clientOsFromRequest: true,
    }),
  });
}

function makeWindowsOriginatedMessage(): MessageRow {
  return makeMessage({
    metadata: JSON.stringify({
      userMessageChannel: "vellum",
      userMessageInterface: "web",
      client: { os: "windows" },
      clientOsFromRequest: true,
    }),
  });
}

/**
 * A turn opened from a plain browser tab, as opposed to the Electron desktop
 * renderer sharing the same web bundle: `client.os` is `"web"` only when
 * `detectClientOs()` fails to resolve an Electron host OS first.
 */
function makeWebOriginatedMessage(): MessageRow {
  return makeMessage({
    metadata: JSON.stringify({
      userMessageChannel: "vellum",
      userMessageInterface: "web",
      client: { os: "web" },
      clientOsFromRequest: true,
    }),
  });
}

function makeAssistantRow(content: ContentBlock[]): MessageRow {
  return makeMessage({
    id: ASSISTANT_MESSAGE_ID,
    role: "assistant",
    content,
    createdAt: 1700000000200,
  });
}

function makeAttentionState(
  overrides: Partial<AttentionState> = {},
): AttentionState {
  return {
    conversationId: CONVERSATION_ID,
    latestAssistantMessageId: ASSISTANT_MESSAGE_ID,
    latestAssistantMessageAt: 1700000000200,
    lastSeenAssistantMessageId: null,
    lastSeenAssistantMessageAt: null,
    lastSeenEventAt: null,
    lastSeenConfidence: null,
    lastSeenSignalType: null,
    lastSeenSourceChannel: null,
    lastSeenSource: null,
    lastSeenEvidenceText: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000200,
    ...overrides,
  };
}

const NON_USER_KIND_CASES: Array<{
  name: string;
  overrides: Partial<ConversationRow>;
}> = [
  { name: "background", overrides: { conversationType: "background" } },
  { name: "scheduled", overrides: { conversationType: "scheduled" } },
  {
    name: "memory-consolidation",
    overrides: { source: MEMORY_V2_CONSOLIDATION_SOURCE },
  },
];

const warnCalls: unknown[] = [];
const rlog = {
  warn: (...args: unknown[]) => {
    warnCalls.push(args);
  },
} as any;

async function run(
  overrides: Partial<Parameters<typeof emitAssistantReplyNotification>[0]> = {},
): Promise<void> {
  await emitAssistantReplyNotification({
    conversationId: CONVERSATION_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    userMessageId: USER_MESSAGE_ID,
    rlog,
    ...overrides,
  });
}

beforeEach(() => {
  pendingBackgroundWork = false;
  pendingWorkStartedAt = undefined;
  firstAssistantRow = null;
  persistedRows = undefined;
  recentHistoryPages.length = 0;
  pendingWorkArgs.length = 0;
  emitCalls.length = 0;
  warnCalls.length = 0;
  messageLookups.length = 0;
  attachmentLookups.length = 0;
  guardianPrincipalId = "guardian-1";
  guardianLookupGate = undefined;
  onGuardianLookup = () => {};
  desktopPresenceArgs.length = 0;
  webPresenceArgs.length = 0;
  assistantAttachments = [];
  desktopAttended = false;
  desktopPresenceShouldThrow = false;
  webFocused = false;
  webPresenceShouldThrow = false;
  getConversationShouldThrow = false;
  conversationRow = makeConversation();
  assistantRow = makeAssistantRow([
    { type: "text", text: "Sure, here is the plan." },
  ] as ContentBlock[]);
  initiatingRow = makeMessage();
  attentionState = makeAttentionState();
  // Empty overrides = every flag resolves to its registry default, so the
  // kill switch reads as enabled unless a case says otherwise.
  setOverridesForTesting({});
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("emitAssistantReplyNotification", () => {
  function appendCompletedContinuation(): void {
    persistedRows = [
      ...(persistedRows ?? [initiatingRow!, assistantRow!]),
      makeMessage({
        id: "msg-completed-trigger",
        createdAt: assistantRow!.createdAt,
        metadata: JSON.stringify({
          backgroundEventSource: "background-tool",
          backgroundToolCompletion: {
            id: "tool-completed",
            toolName: "bash",
            conversationId: CONVERSATION_ID,
            command: "example-command",
            startedAt: assistantRow!.createdAt,
            completedAt: assistantRow!.createdAt,
            status: "completed",
            exitCode: 0,
            output: "completed",
          },
        }),
      }),
      makeMessage({
        id: "msg-completed-result",
        role: "assistant",
        createdAt: assistantRow!.createdAt,
        content: [{ type: "text", text: "The requested work is finished." }],
      }),
    ];
  }

  test.each([false, true])(
    "suppresses a stale kickoff after fast completion with projected=%s and timestamp ties",
    async (projected) => {
      assistantRow!.content = [{ type: "text", text: "The work is started." }];
      appendCompletedContinuation();
      if (projected) {
        attentionState!.latestAssistantMessageId = "msg-completed-result";
      }

      await run();

      expect(pendingBackgroundWork).toBe(false);
      expect(emitCalls).toHaveLength(0);
    },
  );

  test.each(["new continuation", "pending continuation", "reply seen"])(
    "rechecks freshness after presence lookup when there is a %s",
    async (change) => {
      const { promise: lookupStarted, resolve: markLookupStarted } =
        Promise.withResolvers<void>();
      const { promise: lookupReady, resolve: releaseLookup } =
        Promise.withResolvers<void>();
      onGuardianLookup = markLookupStarted;
      guardianLookupGate = lookupReady;
      const notification = run();
      await lookupStarted;
      if (change === "new continuation") {
        appendCompletedContinuation();
      } else if (change === "pending continuation") {
        pendingBackgroundWork = true;
      } else {
        attentionState!.lastSeenAssistantMessageAt = assistantRow!.createdAt;
      }
      releaseLookup();
      await notification;

      expect(emitCalls).toHaveLength(0);
    },
  );

  test.each(["text", "media"])(
    "keeps an unseen public %s reply with a same-turn private wrap-up across history pages",
    async (replyType) => {
      if (replyType === "media") {
        assistantRow!.content = [];
        assistantAttachments = [{ originalFilename: "report.pdf" }];
      }
      persistedRows = [initiatingRow!, assistantRow!];
      for (let index = 0; index < 110; index++) {
        persistedRows.push(
          makeMessage({
            id: `msg-private-${index}`,
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `tool-${index}`,
                name: "bash",
                input: {},
              },
            ],
            metadata: JSON.stringify({ assistantTextVisibility: "private" }),
            createdAt: assistantRow!.createdAt + index + 1,
          }),
          makeMessage({
            id: `msg-tool-result-${index}`,
            content: [
              {
                type: "tool_result",
                tool_use_id: `tool-${index}`,
                content: "ok",
              },
            ],
            createdAt: assistantRow!.createdAt + index + 1,
          }),
        );
      }
      const wrapUp = makeMessage({
        id: "msg-private-wrap-up",
        role: "assistant",
        content: [{ type: "text", text: "Private working notes." }],
        metadata: JSON.stringify({ assistantTextVisibility: "private" }),
        createdAt: assistantRow!.createdAt + 200,
      });
      persistedRows.push(wrapUp);
      attentionState!.latestAssistantMessageId = wrapUp.id;
      attentionState!.latestAssistantMessageAt = wrapUp.createdAt;

      await run();

      expect(recentHistoryPages).toContain(
        persistedRows[persistedRows.length - 200].id,
      );
      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        replyType === "media" ? "Sent report.pdf" : "Sure, here is the plan.",
      );
    },
  );

  test("does not reuse a seen public reply because a private wrap-up is unseen", async () => {
    const wrapUp = makeMessage({
      id: "msg-private-wrap-up",
      role: "assistant",
      metadata: JSON.stringify({ assistantTextVisibility: "private" }),
      createdAt: assistantRow!.createdAt + 1,
    });
    persistedRows = [initiatingRow!, assistantRow!, wrapUp];
    attentionState!.latestAssistantMessageId = wrapUp.id;
    attentionState!.latestAssistantMessageAt = wrapUp.createdAt;
    attentionState!.lastSeenAssistantMessageAt = assistantRow!.createdAt;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test.each([false, true])(
    "keeps a newer reply eligible when older work starts its continuation, completed=%s",
    async (completed) => {
      appendCompletedContinuation();
      const trigger = persistedRows![2];
      const metadata = JSON.parse(trigger.metadata!);
      metadata.backgroundToolCompletion.startedAt =
        assistantRow!.createdAt - 1000;
      trigger.metadata = JSON.stringify(metadata);
      if (!completed) {
        persistedRows!.pop();
      }
      await run();
      expect(emitCalls).toHaveLength(1);
    },
  );

  test("keeps a later human reply eligible after old background completion", async () => {
    appendCompletedContinuation();
    persistedRows = persistedRows!.map((row) => ({
      ...row,
      id: `old-${row.id}`,
      createdAt: row.createdAt - 1000,
    }));
    persistedRows!.push(initiatingRow!, assistantRow!);

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  test.each([false, true])(
    "preserves a mixed human/hidden batch unless a later continuation exists=%s",
    async (laterContinuation) => {
      initiatingRow!.metadata = JSON.stringify({
        turnOutcome: "batched",
        turnBatchedInto: "msg-hidden-batch-tail",
      });
      const hiddenTail = makeMessage({
        id: "msg-hidden-batch-tail",
        metadata: JSON.stringify({ hidden: true }),
      });
      persistedRows = [initiatingRow!, hiddenTail, assistantRow!];
      if (laterContinuation) {
        appendCompletedContinuation();
      }

      await run();

      expect(emitCalls).toHaveLength(laterContinuation ? 0 : 1);
    },
  );

  test.each([undefined, "", 123, "msg-missing-target"])(
    "rejects a malformed or missing batch target %s",
    async (turnBatchedInto) => {
      initiatingRow!.metadata = JSON.stringify({
        turnOutcome: "batched",
        turnBatchedInto,
      });

      await run();

      expect(emitCalls).toHaveLength(0);
    },
  );

  test("scopes unfinished work to this reply's turn, including its tool-call rows", async () => {
    firstAssistantRow = makeMessage({
      id: "msg-first-assistant",
      role: "assistant",
      createdAt: 1700000000100,
    });

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(pendingWorkArgs.length).toBeGreaterThan(0);
    for (const args of pendingWorkArgs) {
      expect(args).toEqual([
        CONVERSATION_ID,
        { startedAfter: firstAssistantRow.createdAt },
      ]);
    }
  });

  test("long turns retain the pending work cutoff from their first assistant row", async () => {
    const first = makeMessage({
      id: "msg-first-assistant",
      role: "assistant",
      createdAt: initiatingRow!.createdAt + 1,
    });
    pendingWorkStartedAt = first.createdAt + 1;
    persistedRows = [initiatingRow!, first];
    for (let index = 0; index < 220; index++) {
      persistedRows.push(
        makeMessage({
          id: `msg-long-turn-${index}`,
          role: "assistant",
          createdAt: first.createdAt + index + 2,
        }),
      );
    }
    assistantRow!.createdAt = first.createdAt + 300;
    attentionState!.latestAssistantMessageAt = assistantRow!.createdAt;
    persistedRows.push(assistantRow!);

    await run();

    expect(emitCalls).toHaveLength(0);
    expect(pendingWorkArgs[0]).toEqual([
      CONVERSATION_ID,
      { startedAfter: first.createdAt },
    ]);
  });

  test("does not announce completion while delegated work is pending", async () => {
    pendingBackgroundWork = true;
    assistantRow = makeAssistantRow([
      { type: "text", text: "I have started the requested work." },
    ]);

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("emits one well-formed signal for an unseen user-conversation reply", async () => {
    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]).toEqual({
      sourceEventName: "chat.assistant_reply",
      sourceChannel: "vellum",
      sourceContextId: CONVERSATION_ID,
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestedTitle: "Weekend plans",
        requestedMessage: "Sure, here is the plan.",
      },
      dedupeKey: `chat.assistant_reply:${CONVERSATION_ID}:${ASSISTANT_MESSAGE_ID}`,
    });
    // Completion alerts link to the existing conversation.
    expect("requiresConversation" in emitCalls[0]).toBe(false);
    expect("conversationAffinityHint" in emitCalls[0]).toBe(false);
    expect("routingIntent" in emitCalls[0]).toBe(false);
  });

  test("stays silent when the kill-switch flag is off", async () => {
    setOverridesForTesting({ "assistant-reply-push": false });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  // The push is suppressed downstream, at the source-active pre-gate in
  // `emitNotificationSignal` (covered in `emit-signal-routing-intent.test.ts`),
  // so the producer's contract here is the hint it emits, not the silence.
  describe("desktop presence", () => {
    beforeEach(() => {
      desktopAttended = true;
    });

    for (const [name, makeRow] of [
      ["macOS", makeMacOriginatedMessage],
      ["Windows", makeWindowsOriginatedMessage],
    ] as const) {
      test(`notifies an unseen ${name} reply while the user is in another app`, async () => {
        initiatingRow = makeRow();
        await run();

        expect(emitCalls).toHaveLength(1);
        expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
        expect(desktopPresenceArgs).toEqual([]);
      });
    }

    test("ignores whole-computer presence even when its read would fail", async () => {
      initiatingRow = makeMacOriginatedMessage();
      desktopPresenceShouldThrow = true;
      await run();

      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
      expect(desktopPresenceArgs).toEqual([]);
      expect(warnCalls).toHaveLength(0);
    });
  });

  describe("web presence", () => {
    beforeEach(() => {
      initiatingRow = makeWebOriginatedMessage();
      webFocused = true;
    });

    test("marks the signal source-active while a web tab reports itself focused on this conversation", async () => {
      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(true);
      // Scoped to this conversation, unlike desktop attendance: a focused tab
      // only speaks for the conversation it is actually looking at.
      expect(webPresenceArgs).toEqual([
        [CONVERSATION_ID, { actorPrincipalId: "guardian-1" }],
      ]);
    });

    test("does not suppress without a resolved recipient", async () => {
      guardianPrincipalId = undefined;
      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
      expect(webPresenceArgs).toEqual([]);
    });

    test("leaves the signal live when no web tab is focused on this conversation", async () => {
      webFocused = false;

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
    });

    test("leaves the signal live when the web presence flag is off", async () => {
      setOverridesForTesting({ "web-presence-suppression": false });

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
      expect(webPresenceArgs).toEqual([]);
    });

    test("leaves the signal live when the web presence read throws", async () => {
      webPresenceShouldThrow = true;

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
      expect(warnCalls).toHaveLength(1);
    });

    test("marks the signal source-active for a turn opened from the macOS app when a web tab is focused here", async () => {
      initiatingRow = makeMacOriginatedMessage();

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(true);
      expect(webPresenceArgs).toEqual([
        [CONVERSATION_ID, { actorPrincipalId: "guardian-1" }],
      ]);
    });
  });

  test("omits requestedTitle when the conversation has no title", async () => {
    conversationRow = makeConversation({ title: "   " });

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload).toEqual({
      requestedMessage: "Sure, here is the plan.",
    });
  });

  // Titles are user-controlled (renames, imports), so they get the same
  // treatment as the body rather than riding into the payload verbatim.
  test("strips control characters and newlines out of the title", async () => {
    conversationRow = makeConversation({
      title: "Weekend\nplans\u0007today",
    });

    await run();

    expect(emitCalls[0].contextPayload.requestedTitle).toBe(
      "Weekend plans today",
    );
  });

  test("caps the title at the shared title budget", async () => {
    conversationRow = makeConversation({ title: "T".repeat(300) });

    await run();

    const title = emitCalls[0].contextPayload.requestedTitle as string;
    expect(title).toHaveLength(NOTIFICATION_TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
  });

  test("omits requestedTitle when the title sanitizes to nothing", async () => {
    conversationRow = makeConversation({ title: "\u0000\u0007" });

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload).toEqual({
      requestedMessage: "Sure, here is the plan.",
    });
  });

  // A conversation whose title is still being written stores the message key
  // itself, which is a non-empty string the sanitizer has no reason to reject.
  // Sending it would put a raw key on the lock screen, so it counts as absent.
  test("omits requestedTitle while the title is still generating", async () => {
    conversationRow = makeConversation({
      title: MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING,
    });

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload).toEqual({
      requestedMessage: "Sure, here is the plan.",
    });
  });

  test("omits requestedTitle for the legacy generating placeholder", async () => {
    conversationRow = makeConversation({ title: "Generating title..." });

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload).toEqual({
      requestedMessage: "Sure, here is the plan.",
    });
  });

  test("omits requestedTitle for the untitled placeholder key", async () => {
    conversationRow = makeConversation({
      title: MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED,
    });

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload).toEqual({
      requestedMessage: "Sure, here is the plan.",
    });
  });

  // Only an exact key is a system constant. A title the user or the model
  // wrote that happens to contain one is their copy and travels as written.
  test("keeps a title that merely contains a message key", async () => {
    conversationRow = makeConversation({
      title: `notes on ${MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING}`,
    });

    await run();

    expect(emitCalls[0].contextPayload.requestedTitle).toBe(
      "notes on conversation.title.generating",
    );
  });

  test("caps the preview at 200 chars", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: "a".repeat(300) },
    ] as ContentBlock[]);

    await run();

    const preview = emitCalls[0].contextPayload.requestedMessage as string;
    expect(preview).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  // Control characters would otherwise ride into the APNs payload verbatim.
  // Newlines stay: iOS (and other lock screens) render them as line breaks.
  test("strips control characters and keeps line breaks in the preview", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: "Hello\n\tthere" },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).toBe("Hello\nthere");
  });

  // List indentation and extra blank lines would otherwise spend the preview's
  // length budget on whitespace. Markdown list markers are already gone after
  // flattening; the remaining line breaks are the structure a lock screen can
  // render.
  test("keeps paragraph breaks after collapsing horizontal whitespace", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: "  Here:\n\n  - item\n  - other  " },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "Here:\n\nitem\nother",
    );
  });

  // A lock screen renders no markdown, so syntax that survives to the APNs
  // payload reads as punctuation soup. See `stripMarkdownForPreview`.
  describe("markdown flattening", () => {
    test("previews a media-only reply as its attachments", async () => {
      assistantRow = makeAssistantRow([
        {
          type: "text",
          text: [
            "![vellum scene](vellum://workspace/clients/web/public/cut.mp4)",
            "![hero animation](vellum://workspace/repos/hero.mp4)",
          ].join(" "),
        },
      ] as ContentBlock[]);
      assistantAttachments = [
        { originalFilename: "cut.mp4" },
        { originalFilename: "hero.mp4" },
      ];

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent 2 attachments",
      );
    });

    test("keeps the prose when a reply mixes text and media", async () => {
      assistantRow = makeAssistantRow([
        {
          type: "text",
          text: "Here is the scene: ![vellum scene](vellum://workspace/a.mp4)",
        },
      ] as ContentBlock[]);

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Here is the scene:",
      );
      // The text branch produced a preview, so the fallback never ran.
      expect(attachmentLookups).toEqual([]);
    });

    test("previews a fenced code reply as its code", async () => {
      assistantRow = makeAssistantRow([
        { type: "text", text: "Fixed it:\n```ts\nconst a = 1;\n```" },
      ] as ContentBlock[]);

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Fixed it:\n\nconst a = 1;",
      );
    });

    test("previews a table reply as its cells", async () => {
      assistantRow = makeAssistantRow([
        {
          type: "text",
          text: "## Keys\n\n| Env | Key |\n|---|---|\n| dev | 4Y4L |",
        },
      ] as ContentBlock[]);

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Keys\n\nEnv Key\ndev 4Y4L",
      );
    });

    // Remote embeds are as valid as `vellum://` ones per the system prompt, but
    // they register nothing in the attachment store, so the alt text is the
    // only thing left to name them by. Going silent here would be worse than
    // the raw markdown this change removes.
    test("names a remote embed by its alt text", async () => {
      assistantRow = makeAssistantRow([
        {
          type: "text",
          text: "![the Q3 chart](https://cdn.example.com/q3.png)",
        },
      ] as ContentBlock[]);

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent the Q3 chart",
      );
    });

    test("counts several remote embeds", async () => {
      assistantRow = makeAssistantRow([
        {
          type: "text",
          text: "![one](https://e.com/1.png) ![two](https://e.com/2.png)",
        },
      ] as ContentBlock[]);

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent 2 attachments",
      );
    });

    test("falls back to generic copy for a remote embed with no alt", async () => {
      assistantRow = makeAssistantRow([
        { type: "text", text: "![](https://cdn.example.com/q3.png)" },
      ] as ContentBlock[]);

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent an attachment",
      );
    });

    // A `vellum://` embed becomes an attachment row and a remote one does not,
    // so the two sources have to be counted together, and the tracked embed
    // must not be counted twice.
    test("counts local and remote media together", async () => {
      assistantRow = makeAssistantRow([
        {
          type: "text",
          text: "![local](vellum://workspace/a.mp4) ![remote](https://e.com/b.png)",
        },
      ] as ContentBlock[]);
      assistantAttachments = [{ originalFilename: "a.mp4" }];

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent 2 attachments",
      );
    });

    // `resolveAssistantAttachments` skips a file that is missing, oversized,
    // unreadable, or denied at the host-read approval, so a `vellum://` embed
    // can leave no row. Its alt is then the only label the reply has.
    test("names a tracked embed whose attachment never resolved", async () => {
      assistantRow = makeAssistantRow([
        { type: "text", text: "![the diagram](vellum://workspace/gone.png)" },
      ] as ContentBlock[]);
      assistantAttachments = [];

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent the diagram",
      );
    });

    test("counts only the tracked embeds that failed to resolve", async () => {
      assistantRow = makeAssistantRow([
        {
          type: "text",
          text: "![one](vellum://workspace/1.png) ![two](vellum://workspace/2.png)",
        },
      ] as ContentBlock[]);
      assistantAttachments = [{ originalFilename: "1.png" }];

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent 2 attachments",
      );
    });

    test("does not double count an embed that became an attachment", async () => {
      assistantRow = makeAssistantRow([
        { type: "text", text: "![local](vellum://workspace/a.mp4)" },
      ] as ContentBlock[]);
      assistantAttachments = [{ originalFilename: "a.mp4" }];

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe("Sent a.mp4");
    });

    test("prefers the attachment row over the alt text when both exist", async () => {
      assistantRow = makeAssistantRow([
        { type: "text", text: "![scene](vellum://workspace/cut.mp4)" },
      ] as ContentBlock[]);
      assistantAttachments = [{ originalFilename: "cut.mp4" }];

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe("Sent cut.mp4");
    });

    test("stays silent when a reply has no text, attachments, or embeds", async () => {
      assistantRow = makeAssistantRow([
        { type: "text", text: "## \n\n---" },
      ] as ContentBlock[]);

      await run();

      expect(emitCalls).toHaveLength(0);
      expect(attachmentLookups).toEqual([ASSISTANT_MESSAGE_ID]);
    });
  });

  // Each case asserts the shared classifier's verdict alongside the silence, so
  // the gate is exercised through `resolveConversationKind` rather than through
  // a restatement of its branches.
  for (const { name, overrides } of NON_USER_KIND_CASES) {
    test(`stays silent for a ${name} conversation`, async () => {
      conversationRow = makeConversation(overrides);

      expect(
        resolveConversationKind(
          conversationRow.source,
          conversationRow.conversationType,
        ),
      ).not.toBe("user");

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  test("stays silent when the conversation is missing", async () => {
    conversationRow = null;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the initiating user message is automated", async () => {
    initiatingRow = makeMessage({
      metadata: JSON.stringify({ automated: true }),
    });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  // Machine-signal rows persist with role "user" and are neither tool results
  // nor `automated`, so only the shared echo-suppression classifier keeps a
  // turn opened by one of them from pushing a reply.
  const LIFECYCLE_ROW_CASES: Array<{ name: string; metadata: unknown }> = [
    {
      name: "subagent notification",
      metadata: {
        subagentNotification: {
          subagentId: "sub-1",
          label: "researcher",
          status: "running",
          conversationId: "conv-child-1",
          objective: "look something up",
        },
      },
    },
    {
      name: "ACP notification",
      metadata: { acpNotification: { acpSessionId: "acp-1", agent: "codex" } },
    },
    { name: "hidden machine signal", metadata: { hidden: true } },
  ];

  for (const { name, metadata } of LIFECYCLE_ROW_CASES) {
    test(`stays silent when the turn was opened by a ${name} row`, async () => {
      initiatingRow = makeMessage({ metadata: JSON.stringify(metadata) });

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  test("pushes the reply to a hidden voice continuation result", async () => {
    initiatingRow = makeMessage({
      metadata: JSON.stringify({
        hidden: true,
        voiceContinuationResult: true,
      }),
    });

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  // A pointer turn fact-checks the rows it generated only after the turn ends
  // and deletes them when validation fails, so a push at turn end would have
  // already carried a call outcome the deterministic fallback then replaces.
  test("stays silent when the turn was opened by a pointer instruction", async () => {
    initiatingRow = makeMessage({
      metadata: JSON.stringify({ pointerInstruction: true }),
    });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  // The phone case carries a `phone` channel; the in-app live-voice case is
  // `vellum`/`macos`, identical to a typed desktop send, which is why the
  // channel field cannot stand in for the `voiceSessionTurn` marker.
  const VOICE_ROW_CASES: Array<{ name: string; metadata: unknown }> = [
    {
      name: "phone call",
      metadata: {
        voiceSessionTurn: true,
        userMessageChannel: "phone",
        userMessageInterface: "phone",
      },
    },
    {
      name: "in-app live voice",
      metadata: {
        voiceSessionTurn: true,
        userMessageChannel: "vellum",
        userMessageInterface: "macos",
      },
    },
  ];

  for (const { name, metadata } of VOICE_ROW_CASES) {
    test(`stays silent when the turn was opened by a ${name} utterance`, async () => {
      initiatingRow = makeMessage({ metadata: JSON.stringify(metadata) });

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  test("still emits for a typed desktop send on the same channel", async () => {
    initiatingRow = makeMessage({
      metadata: JSON.stringify({
        userMessageChannel: "vellum",
        userMessageInterface: "macos",
      }),
    });

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  // A channel turn's reply is delivered back to the originating surface, so the
  // sender already has it in Slack/Telegram; a push would be a second copy.
  for (const channel of ["slack", "telegram"] as const) {
    test(`stays silent for a turn opened from ${channel}`, async () => {
      initiatingRow = makeMessage({
        metadata: JSON.stringify({
          userMessageChannel: channel,
          assistantMessageChannel: channel,
        }),
      });

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  // Rows predating the channel stamp (and the daemon paths that omit it) are
  // in-app turns, so an absent channel must not suppress the push.
  test("still emits when the initiating row carries no channel", async () => {
    initiatingRow = makeMessage({
      metadata: JSON.stringify({ userMessageInterface: "web" }),
    });

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  // An unrecognized channel fails the whole metadata schema, so these two
  // cases pin both halves of the permissive fallback: a suppression marker
  // sharing the row still closes its gate, and a row whose only defect is the
  // channel still notifies.
  test("stays silent when a row with an unrecognized channel is also hidden", async () => {
    initiatingRow = makeMessage({
      metadata: JSON.stringify({
        userMessageChannel: "not-a-channel",
        hidden: true,
      }),
    });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("still emits when the initiating row carries an unrecognized channel", async () => {
    initiatingRow = makeMessage({
      metadata: JSON.stringify({ userMessageChannel: "not-a-channel" }),
    });

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  // `replyDeliveredInAppOnly` turns (the retry route re-running a stored
  // anchor) carry none of the anchor's delivery orchestration: nothing is
  // posted back to the channel and no voice session speaks the reply, so the
  // push is the user's only copy.
  const OFF_APP_DELIVERY_CASES: Array<{ name: string; metadata: unknown }> = [
    {
      name: "a Slack anchor",
      metadata: {
        userMessageChannel: "slack",
        assistantMessageChannel: "slack",
      },
    },
    { name: "a Telegram anchor", metadata: { userMessageChannel: "telegram" } },
    {
      name: "a phone-call anchor",
      metadata: { voiceSessionTurn: true, userMessageChannel: "phone" },
    },
    {
      name: "an in-app live-voice anchor",
      metadata: { voiceSessionTurn: true, userMessageChannel: "vellum" },
    },
  ];

  for (const { name, metadata } of OFF_APP_DELIVERY_CASES) {
    test(`emits for an app-only re-run of ${name}`, async () => {
      initiatingRow = makeMessage({ metadata: JSON.stringify(metadata) });

      await run({ replyDeliveredInAppOnly: true });

      expect(emitCalls).toHaveLength(1);
    });
  }

  // The row-shape reasons are properties of the anchor itself, so an app-only
  // re-run does not reopen them.
  const ROW_SHAPE_SUPPRESSION_CASES: Array<{
    name: string;
    metadata: unknown;
  }> = [
    { name: "automated", metadata: { automated: true } },
    { name: "pointer-instruction", metadata: { pointerInstruction: true } },
    { name: "hidden machine-signal", metadata: { hidden: true } },
    {
      name: "background-event",
      metadata: { backgroundEventSource: "schedule" },
    },
  ];

  for (const { name, metadata } of ROW_SHAPE_SUPPRESSION_CASES) {
    test(`stays silent for an app-only re-run of a ${name} anchor`, async () => {
      initiatingRow = makeMessage({ metadata: JSON.stringify(metadata) });

      await run({ replyDeliveredInAppOnly: true });

      expect(emitCalls).toHaveLength(0);
    });
  }

  test("reads the initiating row by the threaded id, not by scanning", async () => {
    await run();

    expect(messageLookups).toEqual([ASSISTANT_MESSAGE_ID, USER_MESSAGE_ID]);
    expect(emitCalls).toHaveLength(1);
  });

  test("stays silent when no initiating user message id was threaded", async () => {
    await run({ userMessageId: undefined });

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the initiating user message row is missing", async () => {
    initiatingRow = null;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("uses the caller-supplied conversation instead of re-reading it", async () => {
    conversationRow = null;

    await run({ conversation: makeConversation({ title: "Handed down" }) });

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload.requestedTitle).toBe("Handed down");
  });

  test("stays silent when the reply is already seen", async () => {
    attentionState = makeAttentionState({
      lastSeenAssistantMessageId: ASSISTANT_MESSAGE_ID,
      lastSeenAssistantMessageAt: 1700000000200,
    });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when there is no attention state row", async () => {
    attentionState = null;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the reply has no user-visible text", async () => {
    assistantRow = makeAssistantRow([
      { type: "tool_use", id: "t1", name: "bash", input: {} },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  // A file- or image-generation reply carries its output as linked attachments
  // rather than text blocks, so the empty-text branch would otherwise swallow
  // the push for a user who left while the assistant was producing the file.
  describe("attachment-only replies", () => {
    beforeEach(() => {
      assistantRow = makeAssistantRow([
        { type: "tool_use", id: "t1", name: "write_file", input: {} },
      ] as ContentBlock[]);
    });

    test("names the single attachment it generated", async () => {
      assistantAttachments = [{ originalFilename: "quarterly-report.pdf" }];

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent quarterly-report.pdf",
      );
      expect(attachmentLookups).toEqual([ASSISTANT_MESSAGE_ID]);
    });

    test("counts the attachments when the reply generated several", async () => {
      assistantAttachments = [
        { originalFilename: "one.png" },
        { originalFilename: "two.png" },
        { originalFilename: "three.png" },
      ];

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent 3 attachments",
      );
    });

    test("falls back to generic copy when the filename sanitizes to nothing", async () => {
      assistantAttachments = [{ originalFilename: "\u0000\u0007" }];

      await run();

      expect(emitCalls[0].contextPayload.requestedMessage).toBe(
        "Sent an attachment",
      );
    });

    test("keeps the fallback body inside the preview budget", async () => {
      assistantAttachments = [{ originalFilename: `${"f".repeat(300)}.png` }];

      await run();

      const preview = emitCalls[0].contextPayload.requestedMessage as string;
      expect(preview).toHaveLength(200);
      expect(preview.endsWith("…")).toBe(true);
    });

    test("stays silent when the reply has neither text nor attachments", async () => {
      await run();

      expect(emitCalls).toHaveLength(0);
      expect(attachmentLookups).toEqual([ASSISTANT_MESSAGE_ID]);
    });
  });

  // The attachment read is the empty-text branch's fallback, so a reply that
  // already has text must not pay for it.
  test("skips the attachment lookup when the reply has text", async () => {
    await run();

    expect(emitCalls).toHaveLength(1);
    expect(attachmentLookups).toEqual([]);
  });

  test("stays silent when the assistant row is missing", async () => {
    assistantRow = null;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("never throws when a dependency throws", async () => {
    getConversationShouldThrow = true;

    await run();

    expect(emitCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
  });
});

/**
 * Tests for `assistant-reply-producer.ts`: which finished replies earn a push,
 * and the shape of the signal the qualifying ones emit.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
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
    return messageId === ASSISTANT_MESSAGE_ID ? assistantRow : initiatingRow;
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
  emitCalls.length = 0;
  warnCalls.length = 0;
  messageLookups.length = 0;
  attachmentLookups.length = 0;
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
    // No conversation-creation fields: the platform channel is push-only.
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
      initiatingRow = makeMacOriginatedMessage();
      desktopAttended = true;
    });

    test("marks the signal source-active while a desktop reports itself attended", async () => {
      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(true);
      // Unscoped by design: the push targets the assistant owner, and a pod
      // has exactly one owner, so no principal filter belongs here.
      expect(desktopPresenceArgs).toEqual([[]]);
    });

    test("marks a Windows-originated signal source-active while attended", async () => {
      initiatingRow = makeWindowsOriginatedMessage();

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(true);
    });

    test("leaves the signal live when no desktop is attended", async () => {
      desktopAttended = false;

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
    });

    test("leaves the signal live when the presence flag is off", async () => {
      setOverridesForTesting({ "desktop-presence-suppression": false });

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
      expect(desktopPresenceArgs).toEqual([]);
    });

    test("leaves the signal live when the presence read throws", async () => {
      desktopPresenceShouldThrow = true;

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
      expect(warnCalls).toHaveLength(1);
    });

    // An attended desktop only speaks for a turn that desktop itself opened.
    // The user can send from the phone minutes after last touching the keyboard,
    // is exactly the reply this producer exists to push.
    const NON_DESKTOP_ORIGIN_CASES: Array<{
      name: string;
      metadata: unknown;
    }> = [
      {
        name: "the iOS app",
        metadata: { client: { os: "ios" }, clientOsFromRequest: true },
      },
      {
        name: "a browser",
        metadata: { client: { os: "web" }, clientOsFromRequest: true },
      },
      {
        name: "a client that reports no OS",
        metadata: { client: {} },
      },
      { name: "a row with no client bag", metadata: {} },
      {
        name: "a client reporting an unknown OS",
        metadata: { client: { os: "bsd" }, clientOsFromRequest: true },
      },
      // The fail-closed shape this gate exists to refuse: a surface action
      // tapped on the phone carries no transport, so persistence stamps the
      // `macos` the conversation's live client state kept from an earlier
      // desktop send. Without the marker that OS names an earlier turn, not
      // this one, and the push the user is waiting for on their phone would
      // be dropped by the attended desktop.
      {
        name: "a row whose macOS OS was inherited, not reported",
        metadata: { userMessageInterface: "web", client: { os: "macos" } },
      },
      // A marker without a matching OS is not evidence of anything.
      {
        name: "a row marked request-reported with no client bag",
        metadata: { clientOsFromRequest: true },
      },
    ];

    for (const { name, metadata } of NON_DESKTOP_ORIGIN_CASES) {
      test(`leaves the signal live for a turn opened from ${name}`, async () => {
        initiatingRow = makeMessage({ metadata: JSON.stringify(metadata) });

        await run();

        expect(emitCalls).toHaveLength(1);
        expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
      });
    }

    // The transport interface is "web" for the macOS app, the iOS app, and a
    // desktop browser alike, so it cannot stand in for the client OS.
    test("leaves the signal live for a web-interface turn with no client OS", async () => {
      initiatingRow = makeMessage({
        metadata: JSON.stringify({
          userMessageChannel: "vellum",
          userMessageInterface: "web",
        }),
      });

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
    });

    // An unrecognized channel fails the whole metadata schema, so the origin
    // read has to answer off the permissive fallback too.
    test("marks the signal source-active when only the channel is unrecognized", async () => {
      initiatingRow = makeMessage({
        metadata: JSON.stringify({
          userMessageChannel: "not-a-channel",
          client: { os: "macos" },
          clientOsFromRequest: true,
        }),
      });

      await run();

      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(true);
    });
  });

  // Same pre-gate as "desktop presence" above, scoped to a browser tab
  // instead of the whole app.
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
      expect(webPresenceArgs).toEqual([[CONVERSATION_ID]]);
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
      expect(webPresenceArgs).toEqual([[CONVERSATION_ID]]);
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
  test("strips control characters and newlines out of the preview", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: "Hello\n\tthere" },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).toBe("Hello there");
  });

  // Blank lines and list indentation would otherwise spend the preview's
  // length budget on whitespace. The bullets go with them: a lock screen
  // renders the marker as literal punctuation, not as a list.
  test("collapses whitespace runs in the preview", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: "  Here:\n\n  - item\n  - other  " },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "Here: item other",
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
        "Fixed it: const a = 1;",
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
        "Keys Env Key dev 4Y4L",
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

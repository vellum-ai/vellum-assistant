/**
 * Tests for `schedule-result-producer.ts`: which finished schedule runs owe
 * the user a notification, and the shape of the signal the qualifying ones
 * emit.
 *
 * The two gates carry the design: a run that notified itself must stay silent
 * (no duplicates for a well-authored schedule), and a run that said nothing
 * must stay silent (no "your schedule ran" noise).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import type { AttentionState } from "../../persistence/conversation-attention-store.js";
import type { MessageRow } from "../../persistence/conversation-crud.js";
import type { ContentBlock } from "../../providers/types.js";

// ── Module mocks ───────────────────────────────────────────────────────
//
// `mock.module` is hoisted, so these intercepts apply before the module under
// test resolves its imports.

const emitCalls: any[] = [];
let assistantRow: MessageRow | null = null;
/** Earlier assistant rows of the same turn (tool-call steps before the reply). */
let turnRows: MessageRow[] = [];
let attentionState: AttentionState | null = null;
let alreadyNotified = false;
const notifiedProbeArgs: Array<[string, number]> = [];

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

const realEventsStore = await import("../events-store.js");
mock.module("../events-store.js", () => ({
  ...realEventsStore,
  hasNotifiedSourceContextSince: (contextId: string, since: number) => {
    notifiedProbeArgs.push([contextId, since]);
    return alreadyNotified;
  },
}));

const CONVERSATION_ID = "conv-sched-1";
const ASSISTANT_MESSAGE_ID = "msg-assistant-1";
const SCHEDULE_ID = "sched-1";
const RUN_ID = "run-1";
const RUN_STARTED_AT = 1700000000000;

const realCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getMessageById: (messageId: string) =>
    messageId === ASSISTANT_MESSAGE_ID
      ? assistantRow
      : (turnRows.find((row) => row.id === messageId) ?? null),
  getAssistantMessageIdsInTurn: (messageId: string) =>
    messageId === ASSISTANT_MESSAGE_ID
      ? [...turnRows.map((row) => row.id), ASSISTANT_MESSAGE_ID]
      : [messageId],
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

const { emitScheduleResultNotification } =
  await import("../schedule-result-producer.js");

// ── Fixtures ───────────────────────────────────────────────────────────

function makeAssistantRow(
  content: ContentBlock[],
  overrides: Partial<MessageRow> = {},
): MessageRow {
  return {
    id: ASSISTANT_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    role: "assistant",
    content,
    createdAt: RUN_STARTED_AT + 200,
    metadata: null,
    clientMessageId: null,
    finalized: 1,
    ...overrides,
  };
}

/** An earlier row of the run's turn holding a single tool call. */
function makeToolCallRow(
  name: string,
  input: Record<string, unknown>,
): MessageRow {
  return makeAssistantRow(
    [{ type: "tool_use", id: `tu-${name}`, name, input }] as ContentBlock[],
    { id: `msg-${name}`, createdAt: RUN_STARTED_AT + 100 },
  );
}

function makeAttentionState(
  overrides: Partial<AttentionState> = {},
): AttentionState {
  return {
    conversationId: CONVERSATION_ID,
    latestAssistantMessageId: ASSISTANT_MESSAGE_ID,
    latestAssistantMessageAt: RUN_STARTED_AT + 200,
    lastSeenAssistantMessageId: null,
    lastSeenAssistantMessageAt: null,
    lastSeenEventAt: null,
    lastSeenConfidence: null,
    lastSeenSignalType: null,
    lastSeenSourceChannel: null,
    lastSeenSource: null,
    lastSeenEvidenceText: null,
    createdAt: RUN_STARTED_AT,
    updatedAt: RUN_STARTED_AT + 200,
    ...overrides,
  };
}

const warnCalls: unknown[] = [];
const infoCalls: unknown[] = [];
const rlog = {
  warn: (...args: unknown[]) => {
    warnCalls.push(args);
  },
  info: (...args: unknown[]) => {
    infoCalls.push(args);
  },
} as any;

async function run(
  overrides: Partial<Parameters<typeof emitScheduleResultNotification>[0]> = {},
): Promise<void> {
  await emitScheduleResultNotification({
    scheduleId: SCHEDULE_ID,
    scheduleName: "Morning briefing",
    conversationId: CONVERSATION_ID,
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    rlog,
    ...overrides,
  });
}

/**
 * The recording emit mock. Re-registered in `beforeEach` because one case
 * swaps in a throwing implementation to prove the producer swallows a pipeline
 * failure, and `mock.module` is process-wide: without this, every test
 * declared after that one would see the throwing version.
 */
function installRecordingEmitMock(): void {
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
}

beforeEach(() => {
  installRecordingEmitMock();
  emitCalls.length = 0;
  warnCalls.length = 0;
  infoCalls.length = 0;
  notifiedProbeArgs.length = 0;
  alreadyNotified = false;
  turnRows = [];
  attentionState = makeAttentionState();
  assistantRow = makeAssistantRow([
    { type: "text", text: "**3 new emails** and one calendar change." },
  ] as ContentBlock[]);
  setOverridesForTesting({ "schedule-result-notify": true });
});

describe("emitScheduleResultNotification", () => {
  test("notifies when a run produced output and never notified itself", async () => {
    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].sourceEventName).toBe("schedule.result");
    expect(emitCalls[0].sourceChannel).toBe("scheduler");
    // The run's conversation is the deep-link target and what earns the
    // home-feed mirror.
    expect(emitCalls[0].sourceContextId).toBe(CONVERSATION_ID);
    expect(emitCalls[0].contextPayload.requestedTitle).toBe("Morning briefing");
    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "**3 new emails** and one calendar change.",
    );
  });

  test("turns literal newline escapes in the run body into real line breaks", async () => {
    assistantRow = makeAssistantRow([
      {
        type: "text",
        text: "Inbox pass:**\\n\\n•** First item worth review.",
      },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "Inbox pass:**\n\n•** First item worth review.",
    );
  });

  test("stays silent when the run already notified itself", async () => {
    alreadyNotified = true;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("bounds the already-notified probe to this run, not the conversation", async () => {
    // A reused conversation carries every prior run's notifications. Without
    // the lower bound, run #2 onward would be silenced by run #1's send.
    await run();

    expect(notifiedProbeArgs).toEqual([[CONVERSATION_ID, RUN_STARTED_AT]]);
  });

  test("stays silent when the run delivered by email through messaging_send", async () => {
    // The schedule skill's prescribed route for rich content. It writes no
    // notification event, so only the tool call shows the user has the result.
    turnRows = [
      makeToolCallRow("messaging_send", {
        platform: "gmail",
        conversation_id: "thread-1",
        message: "Inbox digest…",
      }),
    ];
    assistantRow = makeAssistantRow([
      { type: "text", text: "Sent the digest to your inbox." },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the run posted to Slack through chat.postMessage", async () => {
    turnRows = [
      makeToolCallRow("bash", {
        command:
          'assistant oauth request --provider slack_channel /chat.postMessage --json \'{"channel":"C1","text":"digest"}\'',
      }),
    ];
    assistantRow = makeAssistantRow([
      { type: "text", text: "Posted the digest to #general." },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("still notifies when the run's tool calls were not deliveries", async () => {
    // Bash that reads Slack is not bash that posts to it.
    turnRows = [
      makeToolCallRow("bash", {
        command:
          'assistant oauth request --provider slack_channel /conversations.history --json \'{"channel":"C1"}\'',
      }),
      makeToolCallRow("messaging_search", { query: "newer_than:1d" }),
    ];

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  test("stays silent when the latest reply predates this run", async () => {
    // A reused conversation whose current run wrote no reply: the attention
    // state still points at yesterday's, which must not be re-sent as today's.
    assistantRow = makeAssistantRow(
      [{ type: "text", text: "Yesterday's briefing." }] as ContentBlock[],
      { createdAt: RUN_STARTED_AT - 1 },
    );

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the run produced no assistant message", async () => {
    attentionState = makeAttentionState({ latestAssistantMessageId: null });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the reply flattens to nothing", async () => {
    // A run that ended on tool calls with no closing prose: whitespace and
    // markdown scaffolding only. Nothing to say, so nothing is said.
    assistantRow = makeAssistantRow([
      { type: "text", text: "   \n\n  \n" },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("notifies for an honest empty-handed result", async () => {
    // "Nothing changed" is the briefing's answer, not an absence of one. The
    // user picked this cadence; a run with a real finding still reports.
    assistantRow = makeAssistantRow([
      { type: "text", text: "No new mail since yesterday." },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "No new mail since yesterday.",
    );
  });

  test("keeps markdown in the body so the detail panel renders it", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: "- **PR #12** merged\n- `deploy.sh` failed" },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "- **PR #12** merged\n- `deploy.sh` failed",
    );
  });

  test("emits at medium urgency so it neither posts silently nor alarms", async () => {
    await run();

    expect(emitCalls[0].attentionHints.urgency).toBe("medium");
    expect(emitCalls[0].attentionHints.requiresAction).toBe(false);
    expect(emitCalls[0].attentionHints.isAsyncBackground).toBe(true);
    expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
  });

  test("keys dedupe on the run so sub-hourly schedules are not collapsed", async () => {
    // The pipeline's dedupe window is a flat hour. A schedule-scoped key would
    // silently drop every run after the first within that hour.
    await run();

    expect(emitCalls[0].dedupeKey).toBe(
      `schedule.result:${SCHEDULE_ID}:${RUN_ID}`,
    );
  });

  test("clamps an unbounded schedule name into a title", async () => {
    await run({ scheduleName: "x".repeat(200) });

    expect(
      emitCalls[0].contextPayload.requestedTitle.length,
    ).toBeLessThanOrEqual(60);
  });

  test("truncates a runaway reply rather than carrying it whole", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: "y".repeat(5000) },
    ] as ContentBlock[]);

    await run();

    expect(
      emitCalls[0].contextPayload.requestedMessage.length,
    ).toBeLessThanOrEqual(2000);
  });

  test("stays silent when the flag is off", async () => {
    setOverridesForTesting({ "schedule-result-notify": false });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent for a bootstrap-failure sentinel conversation id", async () => {
    await run({ conversationId: `bootstrap-error:${SCHEDULE_ID}` });

    expect(emitCalls).toHaveLength(0);
  });

  test("swallows an emit failure so a successful run is not failed by it", async () => {
    mock.module("../emit-signal.js", () => ({
      emitNotificationSignal: async () => {
        throw new Error("simulated pipeline failure");
      },
    }));
    const { emitScheduleResultNotification: emitWithBrokenPipeline } =
      await import("../schedule-result-producer.js");

    await emitWithBrokenPipeline({
      scheduleId: SCHEDULE_ID,
      scheduleName: "Morning briefing",
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      rlog,
    });

    // Asserting the cause, not just that something warned: a re-import that
    // failed for an unrelated reason would also land in the catch.
    expect(warnCalls).toHaveLength(1);
    expect((warnCalls[0] as any[])[0].err.message).toBe(
      "simulated pipeline failure",
    );
  });
});

/**
 * A scheduled run resolves the `mainAgent` call site, so it is gated like any
 * app turn: its plain text is private working notes and the reply it delivered
 * is inside a `send_user_message` call. Reading the terminal row raw either
 * exposes the scratchpad or flattens to nothing and the user hears silence.
 */
describe("a gated schedule run", () => {
  const PRIVATE = JSON.stringify({ assistantTextVisibility: "private" });

  /** The row a gated turn ends on: wrap-up notes, nothing delivered. */
  const wrapUpRow = (): MessageRow =>
    makeAssistantRow(
      [{ type: "text", text: "Told them about the mail." }] as ContentBlock[],
      { metadata: PRIVATE },
    );

  /** The earlier row carrying the message the user actually read. */
  const deliveredRow = (message: string): MessageRow =>
    makeAssistantRow(
      [
        { type: "text", text: "checking the inbox" },
        {
          type: "tool_use",
          id: "tu_send",
          name: "send_user_message",
          input: { message },
        },
      ] as ContentBlock[],
      {
        id: "msg-delivered",
        createdAt: RUN_STARTED_AT + 100,
        metadata: PRIVATE,
      },
    );

  test("notifies with the delivered message, not the scratchpad", async () => {
    turnRows = [deliveredRow("3 new emails and one calendar change.")];
    assistantRow = wrapUpRow();

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "3 new emails and one calendar change.",
    );
  });

  test("never quotes the private text of the terminal row", async () => {
    turnRows = [deliveredRow("3 new emails.")];
    assistantRow = wrapUpRow();

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).not.toContain(
      "Told them about the mail.",
    );
  });

  test("reads the delivered message off the terminal row when it carries one", async () => {
    assistantRow = makeAssistantRow(
      [
        { type: "text", text: "private notes" },
        {
          type: "tool_use",
          id: "tu_send",
          name: "send_user_message",
          input: { message: "Nothing new today." },
        },
      ] as ContentBlock[],
      { metadata: PRIVATE },
    );

    await run();

    expect(emitCalls[0].contextPayload.requestedMessage).toBe(
      "Nothing new today.",
    );
  });

  test("stays silent when a gated run delivered nothing at all", async () => {
    turnRows = [
      makeAssistantRow(
        [{ type: "text", text: "just notes" }] as ContentBlock[],
        {
          id: "msg-notes",
          createdAt: RUN_STARTED_AT + 100,
          metadata: PRIVATE,
        },
      ),
    ];
    assistantRow = wrapUpRow();

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("an ordinary run still reads only its last row", async () => {
    // The documented "nothing to say" case: a run ending on tool calls with no
    // prose stays silent rather than reaching back for earlier text.
    turnRows = [
      makeAssistantRow(
        [{ type: "text", text: "earlier prose" }] as ContentBlock[],
        { id: "msg-earlier", createdAt: RUN_STARTED_AT + 100 },
      ),
    ];
    assistantRow = makeAssistantRow([
      { type: "tool_use", id: "tu_x", name: "file_read", input: {} },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls).toHaveLength(0);
  });
});

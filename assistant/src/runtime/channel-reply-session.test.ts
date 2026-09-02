import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelDeliveryResult, StreamOp } from "@vellumai/gateway-client";
import {
  ChannelReplyPayloadSchema,
  StreamOpSchema,
} from "@vellumai/gateway-client";

type DeliverCall = { callbackUrl: string; payload: Record<string, unknown> };

const deliverCalls: DeliverCall[] = [];
let deliverImpl: (
  callbackUrl: string,
  payload: Record<string, unknown>,
) => Promise<ChannelDeliveryResult> = async () => ({
  ok: true,
  ts: "stream-ts-1",
});

const sentStreamOps: StreamOp[] = [];
let streamOpImpl: (op: StreamOp) => Promise<{
  ok: boolean;
  ts?: string;
}> = async () => ({ ok: true, ts: "stream-ts-1" });
/**
 * What the transport lookup reports for the callback under test. A channel
 * declares it can stream by implementing the method, so `undefined` here is a
 * channel that cannot, and `streamPersists` is what says whether the stream
 * leaves the reply behind.
 */
let transportImpl:
  | {
      streamReply?: unknown;
      streamPersists?: boolean;
      maxStreamTextChars?: number;
    }
  | undefined = { streamReply: () => undefined, streamPersists: true };

mock.module("../messaging/providers/index.js", () => ({
  getTransportForCallback: () => transportImpl,
  sendChannelStreamOp: async (
    _callbackUrl: string,
    _chatId: string,
    op: StreamOp,
  ) => {
    // Every op the session emits must be valid on the wire, the same
    // guarantee the reply-payload mock below enforces. A task-only append
    // carrying neither words nor a plan would move nothing, and the
    // refinement is what says so.
    StreamOpSchema.parse(op);
    sentStreamOps.push(op);
    return streamOpImpl(op);
  },
}));

mock.module("./gateway-client.js", () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
  ) => {
    // Every payload the session emits must be valid on the wire — in
    // particular a task-only append must satisfy the contract's
    // text-or-appended-or-plan refinement.
    ChannelReplyPayloadSchema.parse(payload);
    deliverCalls.push({ callbackUrl, payload });
    return deliverImpl(callbackUrl, payload);
  },
}));

import type { AssistantEvent } from "../api/index.js";
import {
  channelCanStreamReply,
  createChannelReplySession,
} from "./channel-reply-session.js";

const CHANNEL = "D-STREAM";
const THREAD_TS = "1700000000.000001";
const CALLBACK_URL = `https://example.test/deliver/slack?channel=${CHANNEL}&threadTs=${THREAD_TS}`;

const textDelta = (text: string): AssistantEvent =>
  ({
    type: "assistant_text_delta",
    text,
    conversationId: "conv-stream",
  }) as AssistantEvent;

const toolUseStart = (toolUseId: string): AssistantEvent =>
  ({
    type: "tool_use_start",
    toolName: "web_search",
    input: { query: "example" },
    conversationId: "conv-stream",
    toolUseId,
  }) as AssistantEvent;

const messageComplete = (messageId: string): AssistantEvent =>
  ({
    type: "message_complete",
    conversationId: "conv-stream",
    messageId,
  }) as AssistantEvent;

/**
 * The model drawing a plan: a `ui_show` tool call on the turn's own stream,
 * which is how a plan reaches a channel.
 *
 * Built as the tool call rather than as a `ui_surface_show` event, because the
 * event goes to the conversation sink and no channel consumes that. A helper
 * that emitted the event would exercise a path production never takes.
 */
const taskProgressShow = (
  steps: Array<{ label: string; status: string; detail?: string }>,
  templateTitle?: string,
): AssistantEvent =>
  ({
    type: "tool_use_start",
    toolName: "ui_show",
    conversationId: "conv-stream",
    toolUseId: "tool-ui-show",
    input: {
      surface_type: "card",
      title: "Task progress",
      data: {
        template: "task_progress",
        templateData: {
          ...(templateTitle ? { title: templateTitle } : {}),
          steps,
        },
      },
    },
  }) as AssistantEvent;

/**
 * The successful result of the tool call above. A plan is only applied once its
 * call reports success, so a test that shows a plan without one asserts that
 * nothing renders.
 */
const toolOk = (toolUseId: string, toolName: string): AssistantEvent =>
  ({
    type: "tool_result",
    toolName,
    result: "ok",
    conversationId: "conv-stream",
    toolUseId,
  }) as AssistantEvent;

const taskProgressUpdate = (
  steps: Array<{ label: string; status: string }>,
): AssistantEvent =>
  ({
    type: "tool_use_start",
    toolName: "ui_update",
    conversationId: "conv-stream",
    toolUseId: "tool-ui-update",
    input: {
      surface_id: "surface-1",
      data: { templateData: { steps } },
    },
  }) as AssistantEvent;

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const slackStreamOps = (): StreamOp[] => sentStreamOps;

const streamedMarkdown = (): string =>
  slackStreamOps()
    .map((op) => op.appended ?? "")
    .join("");

beforeEach(() => {
  // A channel that streams and whose stream is the reply, which is what the
  // suite below assumes unless a test says otherwise.
  transportImpl = { streamReply: () => undefined, streamPersists: true };
  deliverCalls.length = 0;
  sentStreamOps.length = 0;
  streamOpImpl = async () => ({ ok: true, ts: "stream-ts-1" });
  deliverImpl = async () => ({ ok: true, ts: "stream-ts-1" });
});

describe("channelCanStreamReply", () => {
  test("a channel whose transport implements streamReply can stream", () => {
    transportImpl = { streamReply: () => undefined, streamPersists: true };
    expect(channelCanStreamReply(CALLBACK_URL)).toBe(true);
  });

  test("a channel whose transport omits streamReply cannot", () => {
    // Omitting the method is how a channel with no such primitive declares
    // it, so there is nothing else to consult.
    transportImpl = { streamPersists: false };
    expect(channelCanStreamReply(CALLBACK_URL)).toBe(false);
  });

  test("no callback URL is no channel to ask", () => {
    expect(channelCanStreamReply(undefined)).toBe(false);
  });

  test("a session is not created for a channel that cannot stream", () => {
    transportImpl = undefined;
    expect(
      createChannelReplySession({
        replyCallbackUrl: CALLBACK_URL,
        chatId: CHANNEL,
      }),
    ).toBeUndefined();
  });
});

describe("createChannelReplySession", () => {
  test("a start the channel refuses falls back without streaming", async () => {
    // Whether THIS conversation can carry a growing reply is the platform's
    // rule, answered by the transport's own reply to `start`. Slack refusing
    // a turn with no thread, and Telegram refusing a chat that is not
    // private, both arrive here as the same not-ok.
    streamOpImpl = async () => ({ ok: false });
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("The complete answer."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    expect(slackStreamOps().map((op) => op.action)).toEqual(["start"]);
    expect(reconciliation).toEqual({ mode: "fallback" });
  });

  test("a preview stream leaves the reply still owed", async () => {
    // Telegram's draft evaporates rather than becoming the reply, so a
    // channel that does not persist its stream reports `fallback`: durable
    // delivery still sends the reply, exactly as for a channel that never
    // streamed. Reporting `streamed` here would drop the reply entirely.
    transportImpl = { streamReply: () => undefined, streamPersists: false };
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("The complete answer."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    // The preview really was streamed...
    expect(slackStreamOps().map((op) => op.action)).toEqual(["start", "stop"]);
    // ...and the reply is still owed.
    expect(reconciliation).toEqual({ mode: "fallback" });
  });

  test("a preview stream never records an id for crash recovery", async () => {
    // The breadcrumb exists so a retry can reconcile against a message the
    // reader can already see. A preview leaves none, and its id names nothing
    // durable, so recording it would send recovery to edit a message that
    // never existed and lose the reply instead of posting it.
    transportImpl = { streamReply: () => undefined, streamPersists: false };
    const opened: string[] = [];
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      onStreamOpen: (ts) => opened.push(ts),
    })!;

    session.observeEvent(textDelta("The complete answer."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(slackStreamOps().map((op) => op.action)).toEqual(["start", "stop"]);
    expect(opened).toEqual([]);
  });

  test("a stream that becomes the reply does record its id", async () => {
    const opened: string[] = [];
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      onStreamOpen: (ts) => opened.push(ts),
    })!;

    session.observeEvent(textDelta("The complete answer."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(opened).toEqual(["stream-ts-1"]);
  });

  test("streams a fast turn as a single start then stop", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;
    expect(session).toBeDefined();

    session.observeEvent(textDelta("The complete answer."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    expect(slackStreamOps()).toEqual([
      {
        action: "start",
        text: "The complete answer.",
        appended: "The complete answer.",
      },
      {
        action: "stop",
        streamId: "stream-ts-1",
        text: "The complete answer.",
      },
    ]);
    expect(reconciliation).toEqual({
      mode: "streamed",
      messageTs: "stream-ts-1",
      deliveredSegmentCount: 1,
    });
  });

  test("stamps recipient IDs on the start op for a channel turn", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      recipientUserId: "U123",
      recipientTeamId: "T123",
    })!;
    expect(session).toBeDefined();

    session.observeEvent(textDelta("The complete answer."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(slackStreamOps()).toEqual([
      {
        action: "start",
        text: "The complete answer.",
        appended: "The complete answer.",
        audience: { kind: "oneReader", userId: "U123", userOrgId: "T123" },
      },
      {
        action: "stop",
        streamId: "stream-ts-1",
        text: "The complete answer.",
      },
    ]);
  });

  test("coalesces mid-stream deltas into incremental appends", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(textDelta("First half. "));
    await tick(15);
    session.observeEvent(textDelta("Second half."));
    await tick(15);
    const reconciliation = await session.finish();

    expect(slackStreamOps()).toEqual([
      {
        action: "start",
        text: "First half. ",
        appended: "First half. ",
      },
      {
        action: "append",
        streamId: "stream-ts-1",
        text: "First half. Second half.",
        appended: "Second half.",
      },
      {
        action: "stop",
        streamId: "stream-ts-1",
        text: "First half. Second half.",
      },
    ]);
    expect(reconciliation.mode).toBe("streamed");
  });

  test("drains a body wider than the channel's cap, one operation per chunk", async () => {
    transportImpl = {
      streamReply: () => undefined,
      streamPersists: true,
      maxStreamTextChars: 10,
    };
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    const body = "abcdefghijKLMNOPQRSTuvwxy";
    session.observeEvent(textDelta(body));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    const ops = slackStreamOps();
    expect(ops.map((op) => op.action)).toEqual([
      "start",
      "append",
      "append",
      "stop",
    ]);
    // Every chunk fits the cap, and together they are the whole reply.
    expect(ops[0]!.appended).toBe("abcdefghij");
    expect(ops[1]!.appended).toBe("KLMNOPQRST");
    expect(ops[2]!.appended).toBe("uvwxy");
  });

  test("a failed chunk resumes at itself, never at what already landed", async () => {
    // The delivered mark advances once per confirmed operation, so a retry
    // begins at the chunk that failed. Advancing it for a delta the channel
    // only partly took would resume past unsent text, or re-send text the
    // reader can already see.
    transportImpl = {
      streamReply: () => undefined,
      streamPersists: true,
      maxStreamTextChars: 10,
    };
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    let failNextAppend = true;
    streamOpImpl = async (op) => {
      if (op.action === "append" && failNextAppend) {
        failNextAppend = false;
        throw new Error("Simulated append failure");
      }
      return { ok: true, ts: "stream-ts-1" };
    };

    session.observeEvent(textDelta("abcdefghijKLMNOPQRST"));
    await tick(15);
    session.observeEvent(textDelta("uvwxy"));
    await tick(15);
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    const appended = slackStreamOps()
      .filter((op) => op.action === "append")
      .map((op) => op.appended);
    // The first attempt at "KLMNOPQRST" fails and is retried; nothing that
    // landed is ever sent a second time.
    expect(appended[0]).toBe("KLMNOPQRST");
    expect(appended[1]).toBe("KLMNOPQRST");
    expect(appended.filter((c) => c === "abcdefghij")).toHaveLength(0);
    expect(appended.at(-1)).toBe("uvwxy");
  });

  test("hands a body of any width over as one delta", async () => {
    // Splitting belongs to the channel whose API sets the cap, so the session
    // must not pre-split: a channel with a wider cap, or none, would be paying
    // for Slack's. What it owes is the whole delta, once.
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    const body = "x".repeat(20_000);
    session.observeEvent(textDelta(body));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    const ops = slackStreamOps();
    expect(ops.map((op) => op.action)).toEqual(["start", "stop"]);
    expect(ops[0]!.appended).toBe(body);
    expect(ops[0]!.text).toBe(body);
  });

  test("falls back when startStream returns no stream ts", async () => {
    streamOpImpl = async () => ({ ok: false });
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("Answer that never streams."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    expect(slackStreamOps().map((op) => op.action)).toEqual(["start"]);
    expect(reconciliation).toEqual({ mode: "fallback" });
  });

  test("falls back when startStream throws", async () => {
    streamOpImpl = async () => {
      throw new Error("rate limited");
    };
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("Answer that fails to stream."));
    const reconciliation = await session.finish();

    expect(slackStreamOps().map((op) => op.action)).toEqual(["start"]);
    expect(reconciliation).toEqual({ mode: "fallback" });
  });

  test("falls back when stopStream throws after streaming text", async () => {
    streamOpImpl = async (op) => {
      if (op.action === "stop") {
        throw new Error("stop failed");
      }
      return { ok: true, ts: "stream-ts-1" };
    };
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("Streamed body."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    expect(slackStreamOps().map((op) => op.action)).toEqual(["start", "stop"]);
    // The final stop never landed, so the durable path must re-post the reply.
    expect(reconciliation).toEqual({ mode: "fallback" });
  });

  test("keeps streaming when the onStreamOpen breadcrumb write throws", async () => {
    // The stream opened on Slack's side, so a throwing `onStreamOpen` (e.g. a
    // transient breadcrumb write error) must not knock the session into
    // fallback — that would repost the already-visible streamed reply.
    const onStreamOpenCalls: string[] = [];
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      onStreamOpen: (streamTs) => {
        onStreamOpenCalls.push(streamTs);
        throw new Error("transient SQLite write error");
      },
    })!;
    expect(session).toBeDefined();

    session.observeEvent(textDelta("The complete answer."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    // The callback fired with the opened stream's ts, and its throw left the
    // session streaming: the stop still lands and finalize reconciles in place.
    expect(onStreamOpenCalls).toEqual(["stream-ts-1"]);
    expect(slackStreamOps().map((op) => op.action)).toEqual(["start", "stop"]);
    expect(reconciliation).toEqual({
      mode: "streamed",
      messageTs: "stream-ts-1",
      deliveredSegmentCount: 1,
    });
  });

  test("appends task-only progress that advances without new body text", async () => {
    // `chat.appendStream` accepts a chunks-only call, so a plan that advances
    // during tool work lands live instead of waiting for the final stop.
    // @see https://docs.slack.dev/reference/methods/chat.appendStream/
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(
      taskProgressShow([
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate([
        { label: "Search docs", status: "completed" },
        { label: "Summarize", status: "in_progress" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-update", "ui_update"));
    await tick(15);

    expect(slackStreamOps().at(-1)).toEqual({
      action: "append",
      streamId: "stream-ts-1",
      // No `appended`: the plan moved and the words did not. `text` is still
      // the whole reply, which is what a channel that rewrites needs.
      text: "Working on it.",
      plan: {
        steps: [
          { label: "Search docs", status: "completed" },
          { label: "Summarize", status: "in_progress" },
        ],
      },
    });

    await session.finish();

    expect(slackStreamOps().at(-1)).toEqual({
      action: "stop",
      streamId: "stream-ts-1",
      text: "Working on it.",
      plan: {
        steps: [
          { label: "Search docs", status: "completed" },
          { label: "Summarize", status: "in_progress" },
        ],
      },
    });
  });

  test("does not re-append unchanged task progress", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(
      taskProgressShow([{ label: "Search docs", status: "in_progress" }]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate([{ label: "Search docs", status: "in_progress" }]),
    );
    session.observeEvent(toolOk("tool-ui-update", "ui_update"));
    await tick(15);

    // The start already delivered this exact plan state; a matching update
    // must not spend an append on it.
    expect(slackStreamOps().map((op) => op.action)).toEqual(["start"]);
  });

  test("does not advance a plan the surface tool rejected", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(
      taskProgressShow([{ label: "Search docs", status: "in_progress" }]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    session.observeEvent(textDelta("Working on it."));
    await tick(15);

    // A stale surface id or a malformed payload is rejected by the surface
    // tool. The call is an intention, so a plan applied on sight would show a
    // step completed that the canonical surface never accepted.
    session.observeEvent(
      taskProgressUpdate([{ label: "Search docs", status: "completed" }]),
    );
    session.observeEvent({
      type: "tool_result",
      toolName: "ui_update",
      result: "Error: unknown surface_id",
      isError: true,
      conversationId: "conv-stream",
      toolUseId: "tool-ui-update",
    } as AssistantEvent);
    await tick(15);
    await session.finish();

    // Reads the plan in the assistant's own vocabulary. While the op carried
    // Slack task cards this assertion could not fail: their word for the
    // status is "complete", so "completed" was never going to appear whatever
    // the session did with the rejected update.
    const statuses = slackStreamOps()
      .flatMap((op) => op.plan?.steps ?? [])
      .map((step) => step.status);
    expect(statuses).not.toContain("completed");
    expect(statuses).toContain("in_progress");
  });

  test("leaves progress to stop when the task-only append fails", async () => {
    streamOpImpl = async (op) => {
      if (op.action === "append" && op.appended === undefined) {
        throw new Error("chunks-only append rejected");
      }
      return { ok: true, ts: "stream-ts-1" };
    };
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(
      taskProgressShow([{ label: "Search docs", status: "in_progress" }]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate([{ label: "Search docs", status: "completed" }]),
    );
    session.observeEvent(toolOk("tool-ui-update", "ui_update"));
    await tick(15);
    const reconciliation = await session.finish();

    // The first rejection disables task-only appends for the session, so
    // later progress updates do not retry a doomed call.
    const taskOnlyAttempts = slackStreamOps().filter(
      (op) => op.action === "append" && op.appended === undefined,
    );
    expect(taskOnlyAttempts.length).toBe(1);

    // The failed task-only append does not degrade the stream; the plan
    // still lands on the final stop.
    expect(reconciliation.mode).toBe("streamed");
    expect(slackStreamOps().at(-1)).toEqual({
      action: "stop",
      streamId: "stream-ts-1",
      text: "Working on it.",
      plan: { steps: [{ label: "Search docs", status: "completed" }] },
    });
  });

  test("never opens a stream for a no_response-only turn", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("<no_response/>"));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    expect(deliverCalls).toEqual([]);
    expect(reconciliation).toEqual({ mode: "fallback" });
  });

  test("holds the stream while a no_response sentinel arrives in pieces", async () => {
    // A coalesce timer must not open a stream on the leading `<` of a slowly
    // streamed `<no_response/>`, which would leak a stray partial message.
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(textDelta("<"));
    await tick(15);
    expect(deliverCalls).toEqual([]);

    session.observeEvent(textDelta("no_response"));
    await tick(15);
    expect(deliverCalls).toEqual([]);

    session.observeEvent(textDelta("/>"));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    expect(deliverCalls).toEqual([]);
    expect(reconciliation).toEqual({ mode: "fallback" });
  });

  test("withholds an in-progress vellum link until it closes, then strips it", async () => {
    // Slack streams are append-only, so a `[label](vellum://…)` link split
    // across deltas must not stream its internal path before the closing `)`
    // arrives — once emitted it could not be retracted.
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(textDelta("Here is your file: [report.pdf]("));
    await tick(15);
    session.observeEvent(textDelta("vellum://workspace/scratch/report"));
    await tick(15);

    // Nothing containing the internal path may have been streamed yet.
    for (const op of slackStreamOps()) {
      expect(JSON.stringify(op)).not.toContain("vellum://");
    }

    session.observeEvent(textDelta(".pdf)"));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    const ops = slackStreamOps();
    const streamed = ops.map((op) => op.appended ?? "").join("");
    expect(streamed).toBe("Here is your file: report.pdf");
    expect(streamed).not.toContain("vellum://");
  });

  test("counts deliverable text segments split at tool boundaries", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("Before the tool."));
    session.observeEvent(toolUseStart("toolu_1"));
    session.observeEvent(textDelta(" After the tool."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    expect(reconciliation).toEqual({
      mode: "streamed",
      messageTs: "stream-ts-1",
      deliveredSegmentCount: 2,
    });
  });

  test("inserts a space between segments fused across a tool boundary", async () => {
    // The model ends one segment with a period and opens the next with a
    // capital letter, supplying no separating whitespace on either side.
    // Concatenating them raw would fuse "Sentence one.Sentence two.".
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("Sentence one."));
    session.observeEvent(toolUseStart("toolu_1"));
    session.observeEvent(textDelta("Sentence two."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(streamedMarkdown()).toBe("Sentence one. Sentence two.");
  });

  test("inserts a space between separate model responses", async () => {
    // Multiple `message_complete` events fire within one streamed turn (one
    // per model response). Text from the second response must not fuse onto
    // the first.
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("First response."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    session.observeEvent(textDelta("Second response."));
    session.observeEvent(messageComplete("assistant-msg-2"));
    await session.finish();

    expect(streamedMarkdown()).toBe("First response. Second response.");
  });

  test("does not double-space a boundary the model already spaced", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("Before the tool."));
    session.observeEvent(toolUseStart("toolu_1"));
    session.observeEvent(textDelta(" After the tool."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(streamedMarkdown()).toBe("Before the tool. After the tool.");
  });

  test("does not fuse mid-word deltas within a single segment", async () => {
    // Intra-segment token deltas carry the model's own spacing and must never
    // be altered — only tool/message boundaries introduce a separating space.
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    session.observeEvent(textDelta("super"));
    session.observeEvent(textDelta("cali"));
    session.observeEvent(textDelta("fragilistic"));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(streamedMarkdown()).toBe("supercalifragilistic");
  });

  test("opens the stream in plan mode and advances task cards", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(
      taskProgressShow([
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate([
        { label: "Search docs", status: "completed" },
        { label: "Summarize", status: "in_progress" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-update", "ui_update"));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    const ops = slackStreamOps();
    expect(ops[0]).toEqual({
      action: "start",
      text: "Working on it.",
      appended: "Working on it.",
      plan: {
        steps: [
          { label: "Search docs", status: "in_progress" },
          { label: "Summarize", status: "pending" },
        ],
      },
    });
    expect(ops.at(-1)).toEqual({
      action: "stop",
      streamId: "stream-ts-1",
      text: "Working on it.",
      plan: {
        steps: [
          { label: "Search docs", status: "completed" },
          { label: "Summarize", status: "in_progress" },
        ],
      },
    });
    expect(reconciliation.mode).toBe("streamed");
  });

  test("renders a plan created after the stream opened", async () => {
    // The model typically streams an acknowledgment before it creates the
    // task_progress surface. Slack fixes the task display mode when the
    // stream starts, so the start must open in plan mode even with no plan
    // active yet — otherwise the late-arriving task cards can never render
    // as a plan.
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(textDelta("On it, starting now."));
    await tick(15);
    session.observeEvent(
      taskProgressShow([
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    await tick(15);
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(slackStreamOps()).toEqual([
      {
        action: "start",
        text: "On it, starting now.",
        appended: "On it, starting now.",
      },
      {
        action: "append",
        streamId: "stream-ts-1",
        text: "On it, starting now.",
        plan: {
          steps: [
            { label: "Search docs", status: "in_progress" },
            { label: "Summarize", status: "pending" },
          ],
        },
      },
      {
        action: "stop",
        streamId: "stream-ts-1",
        text: "On it, starting now.",
        plan: {
          steps: [
            { label: "Search docs", status: "in_progress" },
            { label: "Summarize", status: "pending" },
          ],
        },
      },
    ]);
  });

  test("opens the stream on a plan shown before any prose", async () => {
    // What the Slack `ui_show` description actually instructs: show the card
    // early on a multi-step turn. At that moment the model has written no
    // prose, so a stream that waits for text holds the plan back until the
    // final answer, when the steps it narrates are already finished.
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(
      taskProgressShow([
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    await tick(15);

    // The plan is on Slack before the turn has produced a single character.
    expect(slackStreamOps()).toEqual([
      {
        action: "start",
        text: "",
        appended: "",
        plan: {
          steps: [
            { label: "Search docs", status: "in_progress" },
            { label: "Summarize", status: "pending" },
          ],
        },
      },
    ]);
  });

  test("advances plan steps live while the turn is still working", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(
      taskProgressShow([
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate([
        { label: "Search docs", status: "completed" },
        { label: "Summarize", status: "in_progress" },
      ]),
    );
    session.observeEvent(toolOk("tool-ui-update", "ui_update"));
    await tick(15);

    // The advance rides its own task-only append rather than waiting for the
    // first text, which is the whole point of a live step tracker.
    const advances = slackStreamOps().filter((op) => op.action === "append");
    expect(advances).toHaveLength(1);
    expect(advances[0].plan).toEqual({
      steps: [
        { label: "Search docs", status: "completed" },
        { label: "Summarize", status: "in_progress" },
      ],
    });

    session.observeEvent(textDelta("All done."));
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    // The reply still streams into the same message the plan opened.
    expect(reconciliation).toEqual({
      mode: "streamed",
      messageTs: "stream-ts-1",
      deliveredSegmentCount: 1,
    });
    expect(streamedMarkdown()).toBe("All done.");
  });

  test("carries the plan title and step details onto stream ops", async () => {
    const session = createChannelReplySession({
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
      coalesceMs: 5,
    })!;

    session.observeEvent(
      taskProgressShow(
        [
          {
            label: "Check weather",
            status: "in_progress",
            detail: "Fetching the forecast",
          },
          { label: "Summarize", status: "pending" },
        ],
        "Quick Briefing",
      ),
    );
    session.observeEvent(toolOk("tool-ui-show", "ui_show"));
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    const ops = slackStreamOps();
    expect(ops[0]).toEqual({
      action: "start",
      text: "Working on it.",
      appended: "Working on it.",
      plan: {
        title: "Quick Briefing",
        steps: [
          {
            label: "Check weather",
            status: "in_progress",
            detail: "Fetching the forecast",
          },
          { label: "Summarize", status: "pending" },
        ],
      },
    });
    // The plan title survives to the final stop, so a reader who only sees
    // the finished message still sees what the plan was called.
    const final = ops.at(-1);
    expect(final?.action).toBe("stop");
    expect(final?.plan?.title).toBe("Quick Briefing");
  });
});

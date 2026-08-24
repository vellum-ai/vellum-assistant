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
mock.module("../messaging/providers/index.js", () => ({
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
import { SLACK_STREAM_MARKDOWN_LIMIT } from "../messaging/providers/slack/api.js";
import {
  createSlackReplySession,
  shouldStreamSlackReply,
} from "./slack-reply-session.js";

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
  deliverCalls.length = 0;
  sentStreamOps.length = 0;
  streamOpImpl = async () => ({ ok: true, ts: "stream-ts-1" });
  deliverImpl = async () => ({ ok: true, ts: "stream-ts-1" });
});

describe("shouldStreamSlackReply", () => {
  test("admits a threaded Slack DM", () => {
    expect(
      shouldStreamSlackReply({
        sourceChannel: "slack",
        chatType: "im",
        replyCallbackUrl: CALLBACK_URL,
      }),
    ).toBe(true);
  });

  test("rejects a DM whose callback URL carries no thread_ts", () => {
    expect(
      shouldStreamSlackReply({
        sourceChannel: "slack",
        chatType: "im",
        replyCallbackUrl: `https://example.test/deliver/slack?channel=${CHANNEL}`,
      }),
    ).toBe(false);
  });

  test("admits a channel turn carrying both recipient IDs", () => {
    expect(
      shouldStreamSlackReply({
        sourceChannel: "slack",
        chatType: "channel",
        replyCallbackUrl: CALLBACK_URL,
        recipientUserId: "U123",
        recipientTeamId: "T123",
      }),
    ).toBe(true);
  });

  test("admits an app-mention turn (no chatType) carrying both recipient IDs", () => {
    expect(
      shouldStreamSlackReply({
        sourceChannel: "slack",
        replyCallbackUrl: CALLBACK_URL,
        recipientUserId: "U123",
        recipientTeamId: "T123",
      }),
    ).toBe(true);
  });

  test("rejects a channel turn missing the recipient team ID", () => {
    expect(
      shouldStreamSlackReply({
        sourceChannel: "slack",
        chatType: "channel",
        replyCallbackUrl: CALLBACK_URL,
        recipientUserId: "U123",
      }),
    ).toBe(false);
  });

  test("rejects a channel turn missing the recipient user ID", () => {
    expect(
      shouldStreamSlackReply({
        sourceChannel: "slack",
        chatType: "channel",
        replyCallbackUrl: CALLBACK_URL,
        recipientTeamId: "T123",
      }),
    ).toBe(false);
  });

  test("rejects non-Slack channels", () => {
    expect(
      shouldStreamSlackReply({
        sourceChannel: "telegram",
        chatType: "im",
        replyCallbackUrl: CALLBACK_URL,
      }),
    ).toBe(false);
  });
});

describe("createSlackReplySession", () => {
  test("returns undefined for an ineligible turn", () => {
    expect(
      createSlackReplySession({
        sourceChannel: "slack",
        chatType: "channel",
        replyCallbackUrl: CALLBACK_URL,
        chatId: CHANNEL,
      }),
    ).toBeUndefined();
  });

  test("streams a fast turn as a single start then stop", async () => {
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
        anchorMessageId: THREAD_TS,
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "channel",
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
        anchorMessageId: THREAD_TS,
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
        anchorMessageId: THREAD_TS,
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

  test("drains a body wider than the markdown limit across calls", async () => {
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
      replyCallbackUrl: CALLBACK_URL,
      chatId: CHANNEL,
    })!;

    const body = "x".repeat(SLACK_STREAM_MARKDOWN_LIMIT + 4_000);
    session.observeEvent(textDelta(body));
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    const ops = slackStreamOps();
    expect(ops.map((op) => op.action)).toEqual(["start", "append", "stop"]);
    expect((ops[0]!.appended ?? "").length).toBe(SLACK_STREAM_MARKDOWN_LIMIT);
    expect((ops[1]!.appended ?? "").length).toBe(4_000);
    const streamed = (ops[0]!.appended ?? "") + (ops[1]!.appended ?? "");
    expect(streamed).toBe(body);
  });

  test("falls back when startStream returns no stream ts", async () => {
    streamOpImpl = async () => ({ ok: false });
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
      anchorMessageId: THREAD_TS,
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
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
        anchorMessageId: THREAD_TS,
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

  test("carries the plan title and step details onto stream ops", async () => {
    const session = createSlackReplySession({
      sourceChannel: "slack",
      chatType: "im",
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
      anchorMessageId: THREAD_TS,
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

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelDeliveryResult } from "@vellumai/gateway-client";
import { ChannelReplyPayloadSchema } from "@vellumai/gateway-client";

type DeliverCall = { callbackUrl: string; payload: Record<string, unknown> };

const deliverCalls: DeliverCall[] = [];
let deliverImpl: (
  callbackUrl: string,
  payload: Record<string, unknown>,
) => Promise<ChannelDeliveryResult> = async () => ({
  ok: true,
  ts: "stream-ts-1",
});

mock.module("./gateway-client.js", () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
  ) => {
    // Every payload the session emits must be valid on the wire — in
    // particular a task-only append must satisfy the contract's
    // markdownText-or-tasks refinement.
    ChannelReplyPayloadSchema.parse(payload);
    deliverCalls.push({ callbackUrl, payload });
    return deliverImpl(callbackUrl, payload);
  },
}));

import type { ServerMessage } from "../daemon/message-protocol.js";
import { SLACK_STREAM_MARKDOWN_LIMIT } from "../messaging/providers/slack/api.js";
import {
  createSlackReplySession,
  shouldStreamSlackReply,
} from "./slack-reply-session.js";

const CHANNEL = "D-STREAM";
const THREAD_TS = "1700000000.000001";
const CALLBACK_URL = `https://example.test/deliver/slack?channel=${CHANNEL}&threadTs=${THREAD_TS}`;

const textDelta = (text: string): ServerMessage =>
  ({
    type: "assistant_text_delta",
    text,
    conversationId: "conv-stream",
  }) as ServerMessage;

const toolUseStart = (toolUseId: string): ServerMessage =>
  ({
    type: "tool_use_start",
    toolName: "web_search",
    input: { query: "example" },
    conversationId: "conv-stream",
    toolUseId,
  }) as ServerMessage;

const messageComplete = (messageId: string): ServerMessage =>
  ({
    type: "message_complete",
    conversationId: "conv-stream",
    messageId,
  }) as ServerMessage;

const taskProgressShow = (
  surfaceId: string,
  steps: Array<{ label: string; status: string; detail?: string }>,
  templateTitle?: string,
): ServerMessage =>
  ({
    type: "ui_surface_show",
    conversationId: "conv-stream",
    surfaceId,
    surfaceType: "card",
    data: {
      title: "Task progress",
      template: "task_progress",
      templateData: {
        ...(templateTitle ? { title: templateTitle } : {}),
        steps,
      },
    },
  }) as ServerMessage;

const taskProgressUpdate = (
  surfaceId: string,
  steps: Array<{ label: string; status: string }>,
): ServerMessage =>
  ({
    type: "ui_surface_update",
    conversationId: "conv-stream",
    surfaceId,
    data: { templateData: { steps } },
  }) as ServerMessage;

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const slackStreamOps = (): Array<Record<string, unknown>> =>
  deliverCalls
    .map((call) => call.payload.slackStream as Record<string, unknown>)
    .filter(Boolean);

const streamedMarkdown = (): string =>
  slackStreamOps()
    .map((op) => (op.markdownText as string | undefined) ?? "")
    .join("");

beforeEach(() => {
  deliverCalls.length = 0;
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
        threadTs: THREAD_TS,
        markdownText: "The complete answer.",
        taskDisplayMode: "plan",
      },
      { action: "stop", streamTs: "stream-ts-1" },
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
        threadTs: THREAD_TS,
        markdownText: "The complete answer.",
        taskDisplayMode: "plan",
        recipientUserId: "U123",
        recipientTeamId: "T123",
      },
      { action: "stop", streamTs: "stream-ts-1" },
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
        threadTs: THREAD_TS,
        markdownText: "First half. ",
        taskDisplayMode: "plan",
      },
      {
        action: "append",
        streamTs: "stream-ts-1",
        markdownText: "Second half.",
      },
      { action: "stop", streamTs: "stream-ts-1" },
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
    expect((ops[0].markdownText as string).length).toBe(
      SLACK_STREAM_MARKDOWN_LIMIT,
    );
    expect((ops[1].markdownText as string).length).toBe(4_000);
    const streamed =
      (ops[0].markdownText as string) + (ops[1].markdownText as string);
    expect(streamed).toBe(body);
  });

  test("falls back when startStream returns no stream ts", async () => {
    deliverImpl = async () => ({ ok: false });
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
    deliverImpl = async () => {
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
    deliverImpl = async (_url, payload) => {
      const op = payload.slackStream as { action: string };
      if (op.action === "stop") throw new Error("stop failed");
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
      taskProgressShow("surface-1", [
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate("surface-1", [
        { label: "Search docs", status: "completed" },
        { label: "Summarize", status: "in_progress" },
      ]),
    );
    await tick(15);

    expect(slackStreamOps().at(-1)).toEqual({
      action: "append",
      streamTs: "stream-ts-1",
      tasks: [
        { id: "task-0", title: "Search docs", status: "complete" },
        { id: "task-1", title: "Summarize", status: "in_progress" },
      ],
    });

    await session.finish();

    expect(slackStreamOps().at(-1)).toEqual({
      action: "stop",
      streamTs: "stream-ts-1",
      tasks: [
        { id: "task-0", title: "Search docs", status: "complete" },
        { id: "task-1", title: "Summarize", status: "in_progress" },
      ],
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
      taskProgressShow("surface-1", [
        { label: "Search docs", status: "in_progress" },
      ]),
    );
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate("surface-1", [
        { label: "Search docs", status: "in_progress" },
      ]),
    );
    await tick(15);

    // The start already delivered this exact plan state; a matching update
    // must not spend an append on it.
    expect(slackStreamOps().map((op) => op.action)).toEqual(["start"]);
  });

  test("leaves progress to stop when the task-only append fails", async () => {
    deliverImpl = async (_url, payload) => {
      const op = payload.slackStream as {
        action: string;
        markdownText?: string;
      };
      if (op.action === "append" && op.markdownText === undefined) {
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
      taskProgressShow("surface-1", [
        { label: "Search docs", status: "in_progress" },
      ]),
    );
    await tick(15);
    session.observeEvent(
      taskProgressUpdate("surface-1", [
        { label: "Search docs", status: "completed" },
      ]),
    );
    await tick(15);
    const reconciliation = await session.finish();

    // The first rejection disables task-only appends for the session, so
    // later progress updates do not retry a doomed call.
    const taskOnlyAttempts = slackStreamOps().filter(
      (op) => op.action === "append" && op.markdownText === undefined,
    );
    expect(taskOnlyAttempts.length).toBe(1);

    // The failed task-only append does not degrade the stream; the plan
    // still lands on the final stop.
    expect(reconciliation.mode).toBe("streamed");
    expect(slackStreamOps().at(-1)).toEqual({
      action: "stop",
      streamTs: "stream-ts-1",
      tasks: [{ id: "task-0", title: "Search docs", status: "complete" }],
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
    const streamed = ops
      .map((op) => (op.markdownText as string | undefined) ?? "")
      .join("");
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
      taskProgressShow("surface-1", [
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(
      taskProgressUpdate("surface-1", [
        { label: "Search docs", status: "completed" },
        { label: "Summarize", status: "in_progress" },
      ]),
    );
    session.observeEvent(messageComplete("assistant-msg-1"));
    const reconciliation = await session.finish();

    const ops = slackStreamOps();
    expect(ops[0]).toEqual({
      action: "start",
      threadTs: THREAD_TS,
      markdownText: "Working on it.",
      taskDisplayMode: "plan",
      tasks: [
        { id: "task-0", title: "Search docs", status: "in_progress" },
        { id: "task-1", title: "Summarize", status: "pending" },
      ],
    });
    expect(ops.at(-1)).toEqual({
      action: "stop",
      streamTs: "stream-ts-1",
      tasks: [
        { id: "task-0", title: "Search docs", status: "complete" },
        { id: "task-1", title: "Summarize", status: "in_progress" },
      ],
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

    session.observeEvent(textDelta("On it — starting now."));
    await tick(15);
    session.observeEvent(
      taskProgressShow("surface-1", [
        { label: "Search docs", status: "in_progress" },
        { label: "Summarize", status: "pending" },
      ]),
    );
    await tick(15);
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    expect(slackStreamOps()).toEqual([
      {
        action: "start",
        threadTs: THREAD_TS,
        markdownText: "On it — starting now.",
        taskDisplayMode: "plan",
      },
      {
        action: "append",
        streamTs: "stream-ts-1",
        tasks: [
          { id: "task-0", title: "Search docs", status: "in_progress" },
          { id: "task-1", title: "Summarize", status: "pending" },
        ],
      },
      {
        action: "stop",
        streamTs: "stream-ts-1",
        tasks: [
          { id: "task-0", title: "Search docs", status: "in_progress" },
          { id: "task-1", title: "Summarize", status: "pending" },
        ],
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
        "surface-1",
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
    session.observeEvent(textDelta("Working on it."));
    await tick(15);
    session.observeEvent(messageComplete("assistant-msg-1"));
    await session.finish();

    const ops = slackStreamOps();
    expect(ops[0]).toEqual({
      action: "start",
      threadTs: THREAD_TS,
      markdownText: "Working on it.",
      taskDisplayMode: "plan",
      planTitle: "Quick Briefing",
      tasks: [
        {
          id: "task-0",
          title: "Check weather",
          status: "in_progress",
          details: "Fetching the forecast",
        },
        { id: "task-1", title: "Summarize", status: "pending" },
      ],
    });
    expect(ops.at(-1)).toMatchObject({
      action: "stop",
      planTitle: "Quick Briefing",
    });
  });
});

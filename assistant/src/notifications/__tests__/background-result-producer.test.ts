import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AttentionState } from "../../persistence/conversation-attention-store.js";
import type {
  ConversationRow,
  MessageRow,
} from "../../persistence/conversation-crud.js";
import type { SubagentRecord } from "../../persistence/subagent-store.js";
import type { ContentBlock } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { EmitSignalParams } from "../emit-signal.js";

const conversationId = "conv-parent";
const startedAt = 1_700_000_000_000;
const rows = new Map<string, MessageRow>();
let conversation: ConversationRow;
let task: SubagentRecord;
let attention: AttentionState;
let pending = false;
let toolsPending = false;
let queued = false;
let notifiedContexts = new Set<string>();
let recipient: string | undefined = "principal-owner";
let visible = false;
const signals: EmitSignalParams[] = [];
let resultRows: MessageRow[] = [];

mock.module("../../daemon/conversation-registry.js", () => ({
  allSubagentConversations: () => [],
  findConversation: () => ({
    isProcessing: () => false,
    hasQueuedMessages: () => queued,
  }),
}));

const crud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...crud,
  getConversation: () => conversation,
  getMessageById: (id: string) => rows.get(id) ?? null,
  getAssistantMessageIdsInTurn: (id: string) =>
    [...rows.values()]
      .filter(
        (row) =>
          row.role === "assistant" &&
          row.createdAt <= (rows.get(id)?.createdAt ?? 0),
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((row) => row.id),
  getMessagesAfter: () => resultRows,
}));
const attentionStore =
  await import("../../persistence/conversation-attention-store.js");
mock.module("../../persistence/conversation-attention-store.js", () => ({
  ...attentionStore,
  getAttentionStateByConversationIds: (ids: string[]) =>
    new Map(ids[0] === conversationId ? [[conversationId, attention]] : []),
}));
mock.module("../../persistence/subagent-store.js", () => ({
  getSubagentRecordById: () => task,
  getSubagentRecordByConversationId: () => task,
  getSubagentRecordsByParent: () =>
    pending ? [{ ...task, status: "running" }] : [],
}));
mock.module("../../tools/background-tool-registry.js", () => ({
  listBackgroundTools: () => (toolsPending ? [{}] : []),
}));
mock.module("../events-store.js", () => ({
  hasNotifiedSourceContextSince: (id: string) => notifiedContexts.has(id),
}));
mock.module("../emit-signal.js", () => ({
  emitNotificationSignal: async (signal: EmitSignalParams) => {
    signals.push(signal);
  },
}));
mock.module("../resolve-visible-in-source.js", () => ({
  resolveCompletionRecipientPrincipalId: async () => recipient,
  resolveCompletionVisibleInSourceNow: async () => visible,
}));
const { emitBackgroundResultNotification } =
  await import("../background-result-producer.js");

function row(
  id: string,
  role: "user" | "assistant",
  text: string,
  offset: number,
  metadata?: Record<string, unknown>,
): MessageRow {
  return {
    id,
    conversationId,
    role,
    content: [{ type: "text", text }],
    createdAt: startedAt + offset,
    metadata: metadata ? JSON.stringify(metadata) : null,
    clientMessageId: null,
    finalized: 1,
  };
}
function triggerMetadata(metadata: Record<string, unknown>): void {
  rows.set("trigger", {
    ...rows.get("trigger")!,
    metadata: JSON.stringify(metadata),
  });
}
const rlog = getLogger("background-result-producer-test");
const emit = (
  overrides: Partial<
    Parameters<typeof emitBackgroundResultNotification>[0]
  > = {},
) =>
  emitBackgroundResultNotification({
    conversationId,
    assistantMessageId: "result",
    userMessageId: "trigger",
    rlog,
    ...overrides,
  });

beforeEach(() => {
  rows.clear();
  signals.length = 0;
  pending = false;
  toolsPending = false;
  queued = false;
  notifiedContexts = new Set();
  resultRows = [];
  recipient = "principal-owner";
  visible = false;
  conversation = {
    id: conversationId,
    source: "web",
    conversationType: "standard",
    title: "Research findings",
  } as ConversationRow;
  task = {
    id: "task-123",
    parentConversationId: conversationId,
    conversationId: "conv-child",
    role: "worker",
    status: "completed",
    isFork: false,
    sendResultToUser: null,
    startedAt,
    createdAt: startedAt,
  } as SubagentRecord;
  attention = {
    conversationId,
    latestAssistantMessageId: "result",
    latestAssistantMessageAt: startedAt + 200,
    lastSeenAssistantMessageAt: null,
  } as AttentionState;
  rows.set(
    "trigger",
    row("trigger", "user", "INTERNAL WAKE TEXT", 100, {
      scripted: true,
      subagentNotification: {
        subagentId: task.id,
        label: "Research",
        status: "completed",
        conversationId: task.conversationId,
      },
    }),
  );
  rows.set(
    "result",
    row("result", "assistant", "Here are the completed findings.", 200),
  );
});

describe("background result ownership", () => {
  test("queued continuations settle before the parent announces completion", async () => {
    queued = true;
    await emit();
    expect(signals).toHaveLength(0);
    queued = false;
    await emit();
    expect(signals).toHaveLength(1);
  });

  test("private wrap-up uses the earlier user-facing result", async () => {
    rows.set(
      "visible-result",
      row("visible-result", "assistant", "The requested findings.", 150),
    );
    rows.set(
      "result",
      row("result", "assistant", "Private reasoning", 200, {
        assistantTextVisibility: "private",
      }),
    );
    await emit();
    expect(signals[0].contextPayload?.requestedMessage).toBe(
      "The requested findings.",
    );
  });

  test("delegated result uses its parent's persisted copy and stable task identity", async () => {
    await emit();
    await emit();
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      sourceEventName: "activity.complete",
      sourceContextId: conversationId,
      dedupeKey: `activity.complete:${conversationId}:subagent:${task.id}`,
      contextPayload: {
        requestedMessage: "Here are the completed findings.",
        completion: {
          workId: `subagent:${task.id}`,
          recipientPrincipalId: "principal-owner",
          conversationId,
          owner: "parent_continuation",
        },
      },
    });
    expect(signals[1].dedupeKey).toBe(signals[0].dedupeKey);
    expect(JSON.stringify(signals[0])).not.toContain("INTERNAL WAKE TEXT");
  });
  test("presence comes from the shared completion helper", async () => {
    visible = true;
    await emit();
    expect(signals[0].attentionHints.visibleInSourceNow).toBe(true);
  });
  test("missing recipient never falls back to public delivery", async () => {
    recipient = undefined;
    await emit();
    expect(signals).toHaveLength(0);
  });
  test.each(["scheduled", "background"])(
    "%s conversations keep their existing owner",
    async (kind) => {
      conversation.conversationType = kind as "scheduled" | "background";
      await emit();
      expect(signals).toHaveLength(0);
    },
  );
  test("scheduled continuations in a standard conversation keep the scheduler owner", async () => {
    await emit({ cronRunId: "run-scheduled" });
    expect(signals).toHaveLength(0);
  });
  test.each(["failed", "aborted", "running", "interrupted"])(
    "a %s task never earns a success notification",
    async (status) => {
      task.status = status;
      await emit();
      expect(signals).toHaveLength(0);
    },
  );
  test("silent forks, explicit silence and advisor work stay quiet", async () => {
    task.isFork = true;
    await emit();
    task.isFork = false;
    task.sendResultToUser = false;
    await emit();
    task.sendResultToUser = true;
    task.role = "advisor";
    await emit();
    expect(signals).toHaveLength(0);
  });
  test("a fork explicitly shared with the user notifies", async () => {
    task.isFork = true;
    task.sendResultToUser = true;
    await emit();
    expect(signals).toHaveLength(1);
  });
  test("mismatched task parent cannot opt another conversation into completion", async () => {
    task.parentConversationId = "conv-other";
    await emit();
    expect(signals).toHaveLength(0);
  });
  test("ordinary automation and nonterminal updates do not opt in", async () => {
    triggerMetadata({ scripted: true, hidden: true });
    await emit();
    triggerMetadata({
      subagentNotification: {
        subagentId: task.id,
        label: "Research",
        status: "running",
        conversationId: task.conversationId,
      },
    });
    await emit();
    expect(signals).toHaveLength(0);
  });
  test("ongoing delegated or shell work prevents a premature completion", async () => {
    pending = true;
    await emit();
    pending = false;
    toolsPending = true;
    await emit();
    expect(signals).toHaveLength(0);
  });
  test("explicit delivery or quiet decision by parent or child suppresses fallback", async () => {
    notifiedContexts.add(conversationId);
    await emit();
    notifiedContexts.clear();
    notifiedContexts.add(task.conversationId);
    await emit();
    expect(signals).toHaveLength(0);
  });
  test("failed messaging send keeps fallback; acknowledged send suppresses it", async () => {
    rows.set("send", {
      ...row("send", "assistant", "", 150),
      content: [
        { type: "tool_use", name: "messaging_send", id: "send-1", input: {} },
      ] as ContentBlock[],
    });
    resultRows = [
      {
        ...row("send-result", "user", "", 160),
        content: [
          {
            type: "tool_result",
            tool_use_id: "send-1",
            is_error: true,
            content: "failed",
          },
        ] as ContentBlock[],
      },
    ];
    await emit();
    expect(signals).toHaveLength(1);
    resultRows[0].content = [
      { type: "tool_result", tool_use_id: "send-1", content: "sent" },
    ] as ContentBlock[];
    await emit();
    expect(signals).toHaveLength(1);
  });
  test("empty, private-only, unfinalized, and seen results stay quiet", async () => {
    rows.set("result", row("result", "assistant", "", 200));
    await emit();
    rows.set(
      "result",
      row("result", "assistant", "private notes", 200, {
        assistantTextVisibility: "private",
      }),
    );
    await emit();
    rows.set("result", {
      ...row("result", "assistant", "Result", 200),
      finalized: 0,
    });
    await emit();
    rows.set("result", row("result", "assistant", "Result", 200));
    attention.lastSeenAssistantMessageAt = attention.latestAssistantMessageAt;
    await emit();
    expect(signals).toHaveLength(0);
  });
  test("a newer result does not reannounce an older continuation", async () => {
    attention.latestAssistantMessageId = "newer-result";
    await emit();
    expect(signals).toHaveLength(0);
  });
  test.each(["completed", "failed", "cancelled"])(
    "background command %s only notifies after successful synthesis",
    async (status) => {
      triggerMetadata({
        kind: "background-event",
        backgroundEventSource: "background-tool",
        automated: true,
        backgroundToolCompletion: {
          id: "tool-123",
          toolName: "bash",
          conversationId,
          command: "example-command",
          startedAt,
          completedAt: startedAt + 100,
          status,
          exitCode: status === "completed" ? 0 : 1,
          output: "RAW COMMAND OUTPUT",
        },
      });
      await emit();
      expect(signals).toHaveLength(status === "completed" ? 1 : 0);
      if (status === "completed") {
        expect(signals[0].dedupeKey).toBe(
          `activity.complete:${conversationId}:tool:tool-123`,
        );
        expect(JSON.stringify(signals[0])).not.toContain("RAW COMMAND OUTPUT");
      }
    },
  );
});

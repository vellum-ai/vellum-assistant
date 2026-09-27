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
const externalChannels = ["slack", "telegram", "discord"] as const;
const rows = new Map<string, MessageRow>();
let conversation: ConversationRow;
let task: SubagentRecord;
const siblingTasks = new Map<string, SubagentRecord>();
let attention: AttentionState;
let pending = false;
let toolsPending = false;
let queued = false;
let notifiedContexts = new Set<string>();
let recipient: string | undefined = "principal-owner";
let visible = false;
let lookupBarrier: (() => Promise<void>) | undefined;
let deferredLookup: "recipient" | "presence" = "recipient";
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
  getMessagesAfter: () => resultRows,
  getRecentConversationMessages: (
    _conversationId: string,
    limit: number,
    beforeMessageId?: string,
  ) => {
    let history = [...rows.values()];
    if (beforeMessageId) {
      history = history.slice(
        0,
        history.findIndex((row) => row.id === beforeMessageId),
      );
    }
    return history.slice(-limit);
  },
}));
const attentionStore =
  await import("../../persistence/conversation-attention-store.js");
mock.module("../../persistence/conversation-attention-store.js", () => ({
  ...attentionStore,
  getAttentionStateByConversationIds: (ids: string[]) =>
    new Map(ids[0] === conversationId ? [[conversationId, attention]] : []),
}));
mock.module("../../persistence/subagent-store.js", () => ({
  getSubagentRecordById: (id: string) => siblingTasks.get(id) ?? task,
  getSubagentRecordByConversationId: () => task,
  getSubagentRecordsByParent: () =>
    pending ? [{ ...task, status: "running" }] : [],
}));
mock.module("../../tools/background-tool-registry.js", () => ({
  hasBackgroundToolWork: () => toolsPending,
}));
mock.module("../../runtime/agent-wake-queue.js", () => ({
  hasPendingAgentWake: () => false,
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
  resolveCompletionRecipientPrincipalId: async () => {
    if (deferredLookup === "recipient") {
      await lookupBarrier?.();
    }
    return recipient;
  },
  resolveCompletionVisibleInSourceNow: async () => {
    if (deferredLookup === "presence") {
      await lookupBarrier?.();
    }
    return visible;
  },
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
function setExternalOrigin(channel: (typeof externalChannels)[number]): void {
  conversation.source = channel;
  triggerMetadata({
    ...JSON.parse(rows.get("trigger")!.metadata!),
    userMessageChannel: channel,
    assistantMessageChannel: channel,
  });
  rows.get("result")!.metadata = JSON.stringify({
    assistantMessageChannel: channel,
    providerMeta: JSON.stringify({
      source: channel,
      conversationExternalId: "chat-123",
      eventKind: "message",
    }),
  });
}
const rlog = getLogger("background-result-producer-test");
function finishSiblingCommand(
  status: "failed" | "cancelled",
  privateResult = false,
): void {
  rows.set(
    "later-trigger",
    row("later-trigger", "user", "INTERNAL FAILURE", 300, {
      backgroundEventSource: "background-tool",
      backgroundToolCompletion: {
        id: "tool-sibling",
        toolName: "bash",
        conversationId,
        command: "example-command",
        startedAt,
        completedAt: startedAt + 300,
        status,
        exitCode: 1,
        output: "raw failure",
      },
    }),
  );
  rows.set(
    "later-result",
    row(
      "later-result",
      "assistant",
      "The other command failed.",
      400,
      privateResult ? { assistantTextVisibility: "private" } : undefined,
    ),
  );
  attention.latestAssistantMessageId = "later-result";
  attention.latestAssistantMessageAt = startedAt + 400;
}
function batchSuccessfulResultWithSibling(
  status: "failed" | "cancelled",
): void {
  triggerMetadata({
    ...JSON.parse(rows.get("trigger")!.metadata!),
    turnOutcome: "batched",
    turnBatchedInto: "batch-final",
  });
  rows.delete("result");
  rows.set(
    "batch-final",
    row("batch-final", "user", "INTERNAL SIBLING FAILURE", 100, {
      backgroundEventSource: "background-tool",
      backgroundToolCompletion: {
        id: "tool-batch-final",
        toolName: "bash",
        conversationId,
        command: "example-command",
        startedAt,
        completedAt: startedAt + 100,
        status,
        exitCode: 1,
        output: "raw failure",
      },
    }),
  );
  rows.set(
    "result",
    row("result", "assistant", "The completed portion is ready.", 100),
  );
  attention.latestAssistantMessageAt = startedAt + 100;
}
const internalBatchTriggers = [
  {
    name: "ACP notification",
    metadata: { acpNotification: { acpSessionId: "acp-123" } },
  },
  { name: "hidden message", metadata: { hidden: true } },
  { name: "automated message", metadata: { automated: true } },
  {
    name: "background wake",
    metadata: { backgroundEventSource: "agent-wake" },
  },
] satisfies Array<{ name: string; metadata: Record<string, unknown> }>;
function batchSuccessfulResultWithInternalTrigger(
  metadata: Record<string, unknown> = internalBatchTriggers[0].metadata,
): void {
  batchSuccessfulResultWithSibling("failed");
  rows.get("batch-final")!.metadata = JSON.stringify(metadata);
}
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
  siblingTasks.clear();
  signals.length = 0;
  pending = false;
  toolsPending = false;
  queued = false;
  notifiedContexts = new Set();
  resultRows = [];
  recipient = "principal-owner";
  visible = false;
  lookupBarrier = undefined;
  deferredLookup = "recipient";
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
  test.each(internalBatchTriggers)(
    "$name can anchor a completed task's shared result",
    async ({ metadata }) => {
      batchSuccessfulResultWithInternalTrigger(metadata);

      await emit({ userMessageId: "batch-final" });

      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        dedupeKey: `activity.complete:${conversationId}:subagent:${task.id}`,
        contextPayload: { requestedMessage: "The completed portion is ready." },
      });
    },
  );

  test.each(internalBatchTriggers)(
    "$name without an eligible completed batch member stays silent",
    async ({ metadata }) => {
      batchSuccessfulResultWithInternalTrigger(metadata);
      rows.delete("trigger");

      await emit({ userMessageId: "batch-final" });

      expect(signals).toHaveLength(0);
    },
  );

  test.each([
    { turnOutcome: "failed" },
    { turnOutcome: "cancelled" },
    { voiceSessionTurn: true },
  ])(
    "a non-completion batch anchor preserves %j suppression",
    async (flags) => {
      batchSuccessfulResultWithInternalTrigger({
        ...internalBatchTriggers[0].metadata,
        ...flags,
      });

      await emit({ userMessageId: "batch-final" });

      expect(signals).toHaveLength(0);
    },
  );

  test("an internal batch anchor requires the completed member's matching batch link", async () => {
    batchSuccessfulResultWithInternalTrigger();
    for (const turnBatchedInto of [undefined, "missing-target", "trigger"]) {
      triggerMetadata({
        ...JSON.parse(rows.get("trigger")!.metadata!),
        turnBatchedInto,
      });
      await emit({ userMessageId: "batch-final" });
    }
    triggerMetadata({
      ...JSON.parse(rows.get("trigger")!.metadata!),
      turnOutcome: undefined,
      turnBatchedInto: undefined,
    });
    await emit({ userMessageId: "batch-final" });

    expect(signals).toHaveLength(0);
  });

  test.each([{}, { userMessageChannel: "slack" }, { voiceSessionTurn: true }])(
    "a person's prompt remains a recovery boundary with metadata %j",
    async (metadata) => {
      batchSuccessfulResultWithInternalTrigger(metadata);

      await emit({ userMessageId: "batch-final" });
      finishSiblingCommand("failed");
      await emit({
        userMessageId: "later-trigger",
        assistantMessageId: "later-result",
      });

      expect(signals).toHaveLength(0);
    },
  );

  test("recovery-only skips the current internal batch and recovers an earlier one", async () => {
    batchSuccessfulResultWithInternalTrigger();
    await emit({
      userMessageId: "batch-final",
      assistantMessageId: undefined,
      recoverOnly: true,
    });
    expect(signals).toHaveLength(0);

    finishSiblingCommand("failed");
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: undefined,
      recoverOnly: true,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].contextPayload?.requestedMessage).toBe(
      "The completed portion is ready.",
    );
  });

  test("internal members preserve their shared batch result across history pages", async () => {
    batchSuccessfulResultWithInternalTrigger();
    const finalTrigger = rows.get("batch-final")!;
    const result = rows.get("result")!;
    rows.delete("batch-final");
    rows.delete("result");
    for (let index = 0; index < 210; index++) {
      rows.set(
        `internal-member-${index}`,
        row(`internal-member-${index}`, "user", "INTERNAL UPDATE", 100, {
          hidden: true,
          turnOutcome: "batched",
          turnBatchedInto: finalTrigger.id,
        }),
      );
    }
    rows.set(finalTrigger.id, finalTrigger);
    rows.set(result.id, result);

    await emit({ userMessageId: "batch-final" });

    expect(signals).toHaveLength(1);
    expect(signals[0].dedupeKey).toBe(
      `activity.complete:${conversationId}:subagent:${task.id}`,
    );
  });

  test.each(["failed", "cancelled"] as const)(
    "a successful batched child owns the shared result when the final command is %s",
    async (status) => {
      batchSuccessfulResultWithSibling(status);
      queued = true;
      await emit({ userMessageId: "batch-final" });
      expect(signals).toHaveLength(0);
      queued = false;
      await emit({ userMessageId: "batch-final" });

      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        dedupeKey: `activity.complete:${conversationId}:subagent:${task.id}`,
        contextPayload: {
          requestedMessage: "The completed portion is ready.",
          completion: { workId: `subagent:${task.id}` },
        },
      });
    },
  );

  test("a successful batched command owns the shared result when the final child failed", async () => {
    batchSuccessfulResultWithSibling("failed");
    triggerMetadata({
      ...JSON.parse(rows.get("batch-final")!.metadata!),
      turnOutcome: "batched",
      turnBatchedInto: "batch-final",
      backgroundToolCompletion: {
        ...JSON.parse(rows.get("batch-final")!.metadata!)
          .backgroundToolCompletion,
        id: "tool-success",
        status: "completed",
        exitCode: 0,
      },
    });
    rows.get("batch-final")!.metadata = JSON.stringify({
      subagentNotification: {
        subagentId: "task-failed",
        conversationId: "conv-failed",
        label: "Sibling",
        status: "failed",
      },
    });

    await emit({ userMessageId: "batch-final" });

    expect(signals).toHaveLength(1);
    expect(signals[0].dedupeKey).toBe(
      `activity.complete:${conversationId}:tool:tool-success`,
    );
  });

  test.each(["failed", "cancelled"] as const)(
    "a batched successful task cannot make a %s shared synthesis eligible",
    async (outcome) => {
      batchSuccessfulResultWithSibling("failed");
      rows.get("batch-final")!.metadata = JSON.stringify({
        ...JSON.parse(rows.get("batch-final")!.metadata!),
        turnOutcome: outcome,
      });

      await emit({ userMessageId: "batch-final" });
      finishSiblingCommand("failed");
      await emit({
        userMessageId: "later-trigger",
        assistantMessageId: "later-result",
      });

      expect(signals).toHaveLength(0);
    },
  );

  test("recovery-only skips its current batch but can recover an earlier settled batch", async () => {
    batchSuccessfulResultWithSibling("failed");
    await emit({
      userMessageId: "batch-final",
      assistantMessageId: undefined,
      recoverOnly: true,
    });
    expect(signals).toHaveLength(0);
    finishSiblingCommand("cancelled", true);
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: undefined,
      recoverOnly: true,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].contextPayload?.requestedMessage).toBe(
      "The completed portion is ready.",
    );
  });

  test("a successful final batch member keeps sole ownership of the shared result", async () => {
    batchSuccessfulResultWithSibling("failed");
    const metadata = JSON.parse(rows.get("batch-final")!.metadata!);
    rows.get("batch-final")!.metadata = JSON.stringify({
      ...metadata,
      backgroundToolCompletion: {
        ...metadata.backgroundToolCompletion,
        status: "completed",
        exitCode: 0,
      },
    });

    await emit({ userMessageId: "batch-final" });

    expect(signals).toHaveLength(1);
    expect(signals[0].dedupeKey).toBe(
      `activity.complete:${conversationId}:tool:tool-batch-final`,
    );
  });

  test("an intervening assistant turn invalidates a batch result association", async () => {
    batchSuccessfulResultWithSibling("failed");
    const finalTrigger = rows.get("batch-final")!;
    const result = rows.get("result")!;
    rows.delete("batch-final");
    rows.delete("result");
    rows.set(
      "intervening-result",
      row("intervening-result", "assistant", "Other output", 100),
    );
    rows.set(finalTrigger.id, finalTrigger);
    rows.set(result.id, result);

    await emit({ userMessageId: "batch-final" });

    expect(signals).toHaveLength(0);
  });

  test.each([undefined, "missing-target", "trigger", 123])(
    "a batched result needs its actual final trigger, not %s",
    async (turnBatchedInto) => {
      batchSuccessfulResultWithSibling("failed");
      triggerMetadata({
        ...JSON.parse(rows.get("trigger")!.metadata!),
        turnBatchedInto,
      });

      await emit({ userMessageId: "batch-final" });

      expect(signals).toHaveLength(0);
    },
  );

  test.each([
    "quiet child",
    "wrong parent",
    "failed child",
    "seen result",
    "private result",
    "parent delivered",
    "child delivered",
    "scheduled owner",
  ])("batch recovery preserves %s suppression", async (reason) => {
    batchSuccessfulResultWithSibling("failed");
    switch (reason) {
      case "quiet child":
        task.sendResultToUser = false;
        break;
      case "wrong parent":
        task.parentConversationId = "conv-other";
        break;
      case "failed child":
        task.status = "failed";
        break;
      case "seen result":
        attention.lastSeenAssistantMessageAt = startedAt + 100;
        break;
      case "private result":
        rows.get("result")!.metadata = JSON.stringify({
          assistantTextVisibility: "private",
        });
        break;
      case "parent delivered":
        notifiedContexts.add(conversationId);
        break;
      case "child delivered":
        notifiedContexts.add(task.conversationId);
        break;
    }

    await emit({
      userMessageId: "batch-final",
      ...(reason === "scheduled owner" ? { cronRunId: "run-scheduled" } : {}),
    });

    expect(signals).toHaveLength(0);
  });

  test("keeps a batch result association across a history page boundary", async () => {
    batchSuccessfulResultWithSibling("failed");
    const finalTrigger = rows.get("batch-final")!;
    const result = rows.get("result")!;
    rows.delete("batch-final");
    rows.delete("result");
    for (let index = 0; index < 210; index++) {
      rows.set(
        `batch-member-${index}`,
        row(`batch-member-${index}`, "user", "INTERNAL FAILURE", 100, {
          ...JSON.parse(finalTrigger.metadata!),
          turnOutcome: "batched",
          turnBatchedInto: finalTrigger.id,
        }),
      );
    }
    rows.set(finalTrigger.id, finalTrigger);
    rows.set(result.id, result);

    await emit({ userMessageId: "batch-final" });

    expect(signals).toHaveLength(1);
    expect(signals[0].dedupeKey).toBe(
      `activity.complete:${conversationId}:subagent:${task.id}`,
    );
  });

  test.each([...externalChannels])(
    "an undelivered %s-origin delegated result still emits a completion",
    async (channel) => {
      setExternalOrigin(channel);
      await emit();
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        contextPayload: {
          requestedMessage: "Here are the completed findings.",
          completion: {
            workId: `subagent:${task.id}`,
            conversationId,
            recipientPrincipalId: "principal-owner",
          },
        },
      });
    },
  );

  test.each([...externalChannels])(
    "an undelivered %s-origin background command result still emits a completion",
    async (channel) => {
      triggerMetadata({
        backgroundEventSource: "background-tool",
        backgroundToolCompletion: {
          id: "tool-123",
          toolName: "bash",
          conversationId,
          command: "example-command",
          startedAt,
          completedAt: startedAt + 100,
          status: "completed",
          exitCode: 0,
          output: "RAW COMMAND OUTPUT",
        },
      });
      setExternalOrigin(channel);
      await emit();
      expect(signals).toHaveLength(1);
      expect(signals[0].dedupeKey).toBe(
        `activity.complete:${conversationId}:tool:tool-123`,
      );
      expect(signals[0].contextPayload?.requestedMessage).toBe(
        "Here are the completed findings.",
      );
    },
  );

  test("voice continuation results keep their existing delivery owner", async () => {
    triggerMetadata({
      ...JSON.parse(rows.get("trigger")!.metadata!),
      voiceSessionTurn: true,
    });
    await emit();
    expect(signals).toHaveLength(0);
  });
  test.each(["failed", "cancelled"] as const)(
    "recovers a deferred successful child result when the last command is %s",
    async (status) => {
      toolsPending = true;
      await emit();
      expect(signals).toHaveLength(0);
      toolsPending = false;
      finishSiblingCommand(status);
      await emit({
        userMessageId: "later-trigger",
        assistantMessageId: "later-result",
      });
      expect(signals).toHaveLength(1);
      expect(signals[0].contextPayload?.requestedMessage).toBe(
        "Here are the completed findings.",
      );
      expect(signals[0].dedupeKey).toBe(
        `activity.complete:${conversationId}:subagent:${task.id}`,
      );
    },
  );
  test.each(["child", "parent"] as const)(
    "a later %s delivery only covers results in its own conversation",
    async (deliveryContext) => {
      pending = true;
      await emit();
      expect(signals).toHaveLength(0);
      pending = false;
      const sibling = {
        ...task,
        id: "task-sibling",
        conversationId: "conv-sibling",
      };
      siblingTasks.set(sibling.id, sibling);
      rows.set(
        "later-trigger",
        row("later-trigger", "user", "INTERNAL COMPLETION", 300, {
          subagentNotification: {
            subagentId: sibling.id,
            label: "Other task",
            status: "completed",
            conversationId: sibling.conversationId,
          },
        }),
      );
      rows.set(
        "later-result",
        row("later-result", "assistant", "The other task is ready.", 400),
      );
      attention.latestAssistantMessageId = "later-result";
      attention.latestAssistantMessageAt = startedAt + 400;
      notifiedContexts.add(
        deliveryContext === "child" ? sibling.conversationId : conversationId,
      );

      await emit({
        userMessageId: "later-trigger",
        assistantMessageId: "later-result",
      });

      if (deliveryContext === "parent") {
        expect(signals).toHaveLength(0);
      } else {
        expect(signals).toHaveLength(1);
        expect(signals[0]).toMatchObject({
          dedupeKey: `activity.complete:${conversationId}:subagent:${task.id}`,
          contextPayload: {
            requestedMessage: "Here are the completed findings.",
          },
        });
      }
    },
  );
  test("a private-only or empty final wake can flush the earlier successful result", async () => {
    finishSiblingCommand("failed", true);
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals[0].contextPayload?.requestedMessage).toBe(
      "Here are the completed findings.",
    );
    signals.length = 0;
    rows.delete("later-result");
    attention.latestAssistantMessageId = "result";
    attention.latestAssistantMessageAt = startedAt + 200;
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: undefined,
      recoverOnly: true,
    });
    expect(signals).toHaveLength(1);
  });
  test("a successful result viewed before the last failure is not reannounced", async () => {
    finishSiblingCommand("failed");
    attention.lastSeenAssistantMessageAt = startedAt + 200;
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals).toHaveLength(0);
  });
  test("a later user request ends recovery of earlier completion results", async () => {
    rows.set("new-request", row("new-request", "user", "Another request", 250));
    finishSiblingCommand("failed");
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals).toHaveLength(0);
  });
  test("recovery preserves explicit delivery and quiet decisions", async () => {
    finishSiblingCommand("failed");
    notifiedContexts.add(conversationId);
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals).toHaveLength(0);
  });
  test("a failed synthesis of a successful task is not a recoverable result", async () => {
    const metadata = JSON.parse(rows.get("trigger")!.metadata!);
    triggerMetadata({ ...metadata, turnOutcome: "failed" });
    finishSiblingCommand("failed");
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals).toHaveLength(0);
  });
  test("recovery includes successful output written in the same millisecond as the next trigger", async () => {
    finishSiblingCommand("failed");
    rows.get("result")!.createdAt = rows.get("later-trigger")!.createdAt;
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals).toHaveLength(1);
  });
  test("recovers a successful result across history pages", async () => {
    for (let index = 0; index < 210; index++) {
      rows.set(`tool-result-${index}`, {
        ...row(`tool-result-${index}`, "user", "", 250),
        content: [
          {
            type: "tool_result",
            tool_use_id: `tool-${index}`,
            content: "intermediate output",
          },
        ],
      });
    }
    finishSiblingCommand("failed");
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].contextPayload?.requestedMessage).toBe(
      "Here are the completed findings.",
    );
  });
  test("a final failed child continuation flushes a successful sibling", async () => {
    finishSiblingCommand("failed");
    rows.get("later-trigger")!.metadata = JSON.stringify({
      subagentNotification: {
        subagentId: "task-sibling",
        label: "Sibling",
        status: "failed",
        conversationId: "conv-sibling",
      },
    });
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: undefined,
      recoverOnly: true,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].contextPayload?.requestedMessage).toBe(
      "Here are the completed findings.",
    );
  });
  test("a standalone card cannot become an earlier task's recovered result", async () => {
    rows.set(
      "card",
      row("card", "assistant", "System card text", 250, {
        messageKind: "system_card",
      }),
    );
    finishSiblingCommand("failed");
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals[0].contextPayload?.requestedMessage).toBe(
      "Here are the completed findings.",
    );
  });
  test("seen public output is not reannounced through a later private wrap-up", async () => {
    rows.delete("result");
    rows.set(
      "visible-result",
      row("visible-result", "assistant", "Visible findings", 150),
    );
    rows.set(
      "result",
      row("result", "assistant", "Private wrap-up", 200, {
        assistantTextVisibility: "private",
      }),
    );
    attention.lastSeenAssistantMessageAt = startedAt + 150;
    finishSiblingCommand("failed");
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: "later-result",
    });
    expect(signals).toHaveLength(0);
  });
  test("a newer human prompt prevents a stale wake from recovering an old result", async () => {
    finishSiblingCommand("failed");
    rows.set("new-request", row("new-request", "user", "Another request", 500));
    await emit({
      userMessageId: "later-trigger",
      assistantMessageId: undefined,
      recoverOnly: true,
    });
    expect(signals).toHaveLength(0);
  });
  test("queued continuations settle before the parent announces completion", async () => {
    queued = true;
    await emit();
    expect(signals).toHaveLength(0);
    queued = false;
    await emit();
    expect(signals).toHaveLength(1);
  });

  test("a long continuation still recognizes its early successful message delivery", async () => {
    rows.delete("result");
    const delivery = row("early-delivery", "assistant", "", 101);
    delivery.content = [
      {
        type: "tool_use",
        id: "send-result",
        name: "messaging_send",
        input: {},
      },
    ];
    rows.set(delivery.id, delivery);
    const receipt = row("delivery-receipt", "user", "", 102);
    receipt.content = [
      { type: "tool_result", tool_use_id: "send-result", content: "Delivered" },
    ];
    rows.set(receipt.id, receipt);
    resultRows.push(receipt);
    for (let index = 0; index < 220; index++) {
      rows.set(
        `long-turn-${index}`,
        row(`long-turn-${index}`, "assistant", "Working", 103 + index),
      );
    }
    rows.set("result", row("result", "assistant", "Result ready.", 400));
    attention.latestAssistantMessageAt = startedAt + 400;

    await emit();

    expect(signals).toHaveLength(0);
  });

  test("private wrap-up uses the earlier user-facing result", async () => {
    rows.delete("result");
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
  test.each([...externalChannels])(
    "only an acknowledged messaging send suppresses the %s-origin fallback",
    async (channel) => {
      setExternalOrigin(channel);
      const result = rows.get("result")!;
      rows.delete("result");
      rows.set("send", {
        ...row("send", "assistant", "", 150),
        content: [
          { type: "tool_use", name: "messaging_send", id: "send-1", input: {} },
        ] as ContentBlock[],
      });
      rows.set(result.id, result);
      await emit();
      expect(signals).toHaveLength(1);
      signals.length = 0;
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
    },
  );
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

describe("completion eligibility after asynchronous lookups", () => {
  for (const lookup of ["recipient", "presence"] as const) {
    for (const change of [
      "seen",
      "archived",
      "deleted",
      "queued",
      "tool",
      "child",
      "delivered",
      "new turn",
    ] as const) {
      test(`${change} during ${lookup} lookup suppresses the stale alert`, async () => {
        deferredLookup = lookup;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        lookupBarrier = () => {
          entered.resolve();
          return release.promise;
        };
        const notification = emit({ conversation: { ...conversation } });
        await entered.promise;
        switch (change) {
          case "seen":
            attention.lastSeenAssistantMessageAt =
              attention.latestAssistantMessageAt;
            break;
          case "archived":
            conversation.archivedAt = startedAt + 500;
            break;
          case "deleted":
            rows.clear();
            break;
          case "queued":
            queued = true;
            break;
          case "tool":
            toolsPending = true;
            break;
          case "child":
            pending = true;
            break;
          case "delivered":
            notifiedContexts.add(conversationId);
            break;
          case "new turn":
            rows.set(
              "new-user",
              row("new-user", "user", "Another question", 300),
            );
            break;
        }
        release.resolve();
        await notification;
        expect(signals).toHaveLength(0);
      });
    }

    test(`a newer completion supersedes the alert waiting on ${lookup}`, async () => {
      deferredLookup = lookup;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      lookupBarrier = () => {
        entered.resolve();
        return release.promise;
      };
      const oldNotification = emit();
      await entered.promise;
      finishSiblingCommand("failed");
      const trigger = rows.get("later-trigger")!;
      const metadata = JSON.parse(trigger.metadata!);
      metadata.backgroundToolCompletion.status = "completed";
      metadata.backgroundToolCompletion.exitCode = 0;
      trigger.metadata = JSON.stringify(metadata);
      rows.get("later-result")!.content = [
        { type: "text", text: "The newer result is ready." },
      ];
      lookupBarrier = undefined;
      await emit({
        userMessageId: "later-trigger",
        assistantMessageId: "later-result",
      });
      release.resolve();
      await oldNotification;
      expect(
        signals.map((signal) => signal.contextPayload?.requestedMessage),
      ).toEqual(["The newer result is ready."]);
    });
  }
});

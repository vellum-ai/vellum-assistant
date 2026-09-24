import { beforeEach, expect, mock, test } from "bun:test";

import type {
  QueuedDispatch,
  QueuedMessage,
} from "../../daemon/conversation-queue-manager.js";
import type { SubagentRecord } from "../../persistence/subagent-store.js";

let tasks: Array<
  Pick<SubagentRecord, "role" | "isFork" | "sendResultToUser"> & {
    createdAt?: number;
  }
> = [];
let tools: unknown[] = [];
let queued = false;
let processing = false;
let activeOrigins: QueuedMessage[] | undefined;
let wakeStartedAt: number | undefined;
let liveChild = false;
let childProcessing = true;
let queuedMessages: QueuedMessage[] = [];
let taskCreatedAt = 100;
const parentDispatches = new Map<string | null, Set<QueuedDispatch>>();
const childDispatches = new Map<string | null, Set<QueuedDispatch>>();
let wakeQueued = false;
mock.module("../../runtime/agent-wake-queue.js", () => ({
  hasPendingAgentWake: (
    _id: string,
    _run: string | undefined,
    options?: { startedAfter?: number },
  ) =>
    wakeQueued &&
    (options?.startedAfter === undefined ||
      (wakeStartedAt !== undefined && wakeStartedAt >= options.startedAfter)),
}));
mock.module("../../persistence/subagent-store.js", () => ({
  getSubagentRecordsByParent: () => tasks,
  getSubagentRecordById: () => ({
    role: "worker",
    isFork: false,
    sendResultToUser: true,
    createdAt: taskCreatedAt,
  }),
  getSubagentRecordByConversationId: () => ({
    role: "worker",
    isFork: false,
    sendResultToUser: true,
    createdAt: 100,
  }),
}));
mock.module("../../tools/background-tool-registry.js", () => ({
  hasBackgroundToolWork: (
    _conversationId: string,
    options?: { startedAfter?: number },
  ) =>
    tools.some(
      (tool) =>
        options?.startedAfter === undefined ||
        (tool as { startedAt: number }).startedAt >= options.startedAfter,
    ),
}));
mock.module("../../daemon/conversation-registry.js", () => ({
  allSubagentConversations: () =>
    liveChild
      ? [
          {
            conversationId: "conv-child",
            parentConversationId: "conv-123",
            isProcessing: () => childProcessing,
            pendingQueuedDispatches: childDispatches,
            hasQueuedMessages: () => false,
          },
        ]
      : [],
  findConversation: () => ({
    isProcessing: () => processing,
    currentTurnWorkOrigins: activeOrigins,
    pendingQueuedDispatches: parentDispatches,
    hasQueuedMessages: () => queued || queuedMessages.length > 0,
    snapshotQueuedMessages: () => queuedMessages,
  }),
}));
const { hasPendingBackgroundWork } =
  await import("../has-pending-background-work.js");

beforeEach(() => {
  tasks = [];
  tools = [];
  queued = false;
  queuedMessages = [];
  taskCreatedAt = 100;
  processing = false;
  activeOrigins = undefined;
  wakeStartedAt = undefined;
  liveChild = false;
  childProcessing = true;
  parentDispatches.clear();
  childDispatches.clear();
  wakeQueued = false;
});

test("internal advisor and silent-fork work cannot suppress the user's reply", () => {
  tasks = [
    { role: "advisor", isFork: false, sendResultToUser: null },
    { role: "worker", isFork: true, sendResultToUser: null },
    { role: "worker", isFork: false, sendResultToUser: false },
  ];
  expect(hasPendingBackgroundWork("conv-123")).toBe(false);
});
test("a pending user-facing child, command, or parent continuation delays completion", () => {
  tasks = [{ role: "worker", isFork: false, sendResultToUser: null }];
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  tasks = [{ role: "worker", isFork: true, sendResultToUser: true }];
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  tasks = [];
  tools = [{}];
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  tools = [];
  queued = true;
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  queued = false;
  processing = true;
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  processing = false;
  expect(hasPendingBackgroundWork("conv-123")).toBe(false);
  wakeQueued = true;
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    false,
  );
});

test("a later ordinary reply ignores pending work from an earlier turn", () => {
  tasks = [
    { role: "worker", isFork: false, sendResultToUser: true, createdAt: 100 },
  ];
  tools = [{ startedAt: 100 }];
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    false,
  );
  tasks[0].createdAt = 200;
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    true,
  );
  tasks = [];
  tools = [{ startedAt: 200 }];
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    true,
  );
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
});

test("a terminal child's queued follow-up must settle before completion", () => {
  liveChild = true;
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  expect(hasPendingBackgroundWork("conv-other")).toBe(false);
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    false,
  );
});

test("a dequeued unscheduled continuation suppresses kickoff alerts before its processing claim", () => {
  parentDispatches.set(
    null,
    new Set([
      { controller: new AbortController(), messages: [queuedMessage(100)] },
    ]),
  );
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 100 })).toBe(
    true,
  );
  expect(hasPendingBackgroundWork("conv-123")).toBe(true);
  parentDispatches.clear();
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 100 })).toBe(
    false,
  );
});

test("a terminal child's dequeued continuation remains pending before its claim", () => {
  liveChild = true;
  childProcessing = false;
  childDispatches.set(
    null,
    new Set([
      { controller: new AbortController(), messages: [queuedMessage(100)] },
    ]),
  );
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 100 })).toBe(
    true,
  );
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    false,
  );
  childDispatches.clear();
  expect(hasPendingBackgroundWork("conv-123")).toBe(false);
});

function queuedMessage(
  sentAt: number,
  metadata?: Record<string, unknown>,
): QueuedMessage {
  return {
    content: "Continuation",
    attachments: [],
    requestId: "req-123",
    sentAt,
    metadata,
    onEvent: () => {},
  };
}

for (const state of ["queued", "dispatch", "active"] as const) {
  for (const source of ["user", "subagent", "command"] as const) {
    test(`a newer reply ignores older ${source} work while ${state}`, () => {
      const metadata =
        source === "subagent"
          ? { subagentNotification: { subagentId: "task-123" } }
          : source === "command"
            ? {
                backgroundEventSource: "background-tool",
                backgroundToolCompletion: { startedAt: 100 },
              }
            : undefined;
      const message = queuedMessage(source === "user" ? 100 : 300, metadata);
      if (state === "queued") {
        queuedMessages = [message];
      } else if (state === "active") {
        processing = true;
        activeOrigins = [message];
      } else {
        parentDispatches.set(
          null,
          new Set([{ controller: new AbortController(), messages: [message] }]),
        );
      }
      expect(hasPendingBackgroundWork("conv-123")).toBe(true);
      expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
        false,
      );
      expect(hasPendingBackgroundWork("conv-123", { startedAfter: 100 })).toBe(
        true,
      );
    });
  }
}

test("a mixed dispatch still suppresses the kickoff alert for newer work", () => {
  parentDispatches.set(
    null,
    new Set([
      {
        controller: new AbortController(),
        messages: [queuedMessage(100), queuedMessage(200)],
      },
    ]),
  );
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    true,
  );
});

test("pending command wakes use their originating work time", () => {
  wakeQueued = true;
  wakeStartedAt = 100;
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    false,
  );
  wakeStartedAt = 200;
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    true,
  );
});

test("an older active turn does not hide newer queued work", () => {
  processing = true;
  activeOrigins = [queuedMessage(100)];
  queuedMessages = [queuedMessage(200)];
  expect(hasPendingBackgroundWork("conv-123", { startedAfter: 200 })).toBe(
    true,
  );
});

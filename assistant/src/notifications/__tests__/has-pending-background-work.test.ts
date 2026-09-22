import { beforeEach, expect, mock, test } from "bun:test";

import type { SubagentRecord } from "../../persistence/subagent-store.js";

let tasks: Array<
  Pick<SubagentRecord, "role" | "isFork" | "sendResultToUser"> & {
    createdAt?: number;
  }
> = [];
let tools: unknown[] = [];
let queued = false;
let processing = false;
let liveChild = false;
mock.module("../../persistence/subagent-store.js", () => ({
  getSubagentRecordsByParent: () => tasks,
  getSubagentRecordByConversationId: () => ({
    role: "worker",
    isFork: false,
    sendResultToUser: true,
    createdAt: 100,
  }),
}));
mock.module("../../tools/background-tool-registry.js", () => ({
  listBackgroundTools: () => tools,
}));
mock.module("../../daemon/conversation-registry.js", () => ({
  allSubagentConversations: () =>
    liveChild
      ? [
          {
            conversationId: "conv-child",
            parentConversationId: "conv-123",
            isProcessing: () => true,
            hasQueuedMessages: () => false,
          },
        ]
      : [],
  findConversation: () => ({
    isProcessing: () => processing,
    hasQueuedMessages: () => queued,
  }),
}));
const { hasPendingBackgroundWork } =
  await import("../has-pending-background-work.js");

beforeEach(() => {
  tasks = [];
  tools = [];
  queued = false;
  processing = false;
  liveChild = false;
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

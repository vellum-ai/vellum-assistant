/**
 * The activation checklist records which task was launched into which
 * conversation in a workspace file no database cascade reaches. A delete that
 * skipped it would leave the task's row stuck on Working, pointing at a
 * conversation the user can no longer open and offering no way to launch the
 * task again.
 *
 * The cleanup hangs off the shared delete primitives rather than the route, so
 * every caller (route, retrospective GC, cleanup jobs) cleans up, and it is
 * best-effort like the rest of the post-transaction cleanup: these tests wait
 * for it rather than awaiting it.
 */
import { describe, expect, mock, test } from "bun:test";

// Keep the rest of the module real; only the Qdrant collection drop is
// replaced, so `clearAll` does not reach for a lexical index that is not
// running here.
const actualLexical =
  await import("../persistence/job-handlers/message-lexical.js");
mock.module("../persistence/job-handlers/message-lexical.js", () => ({
  ...actualLexical,
  clearMessagesLexicalIndex: async () => {},
}));

import {
  markActivationTurnComplete,
  readActivationProgress,
  startActivationTask,
} from "../activation/progress-store.js";
import type { ActivationTaskProgress } from "../api/responses/activation.js";
import {
  clearAll,
  createConversation,
  deleteConversation,
  deleteConversationGently,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

function taskRecord(taskId: string): ActivationTaskProgress | undefined {
  return readActivationProgress().tasks[taskId];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the activation checklist to settle");
}

/** A conversation with a `started` checklist task pointing at it. */
async function seedStartedTask(taskId: string): Promise<string> {
  const conversation = createConversation(`activation-${taskId}`);
  await startActivationTask({ taskId, conversationId: conversation.id });
  expect(taskRecord(taskId)).toMatchObject({
    status: "started",
    conversationId: conversation.id,
  });
  return conversation.id;
}

/** A conversation whose checklist task already finished in it. */
async function seedDoneTask(taskId: string): Promise<string> {
  const conversationId = await seedStartedTask(taskId);
  await markActivationTurnComplete({
    conversationId,
    toolCallCount: 2,
    endedAwaitingUser: false,
    artifacts: [],
  });
  expect(taskRecord(taskId)).toMatchObject({ status: "done", stepCount: 2 });
  return conversationId;
}

describe("deleteConversation releases the checklist task", () => {
  test("a started task returns to Todo and can be launched again", async () => {
    const taskId = "delete-started";
    const conversationId = await seedStartedTask(taskId);
    const other = await seedStartedTask("delete-started-other");

    deleteConversation(conversationId);
    await waitFor(() => taskRecord(taskId) === undefined);

    // Scoped to the conversation being deleted.
    expect(taskRecord("delete-started-other")).toMatchObject({
      status: "started",
      conversationId: other,
    });

    // Todo again, so the row is launchable.
    const relaunched = createConversation("activation-relaunch");
    await startActivationTask({ taskId, conversationId: relaunched.id });
    expect(taskRecord(taskId)).toMatchObject({
      status: "started",
      conversationId: relaunched.id,
    });
  });

  test("a finished task keeps its history and loses only the dead link", async () => {
    const taskId = "delete-done";
    const conversationId = await seedDoneTask(taskId);

    deleteConversation(conversationId);
    await waitFor(() => taskRecord(taskId)?.conversationId === "");

    expect(taskRecord(taskId)).toMatchObject({
      status: "done",
      stepCount: 2,
      conversationId: "",
    });
  });
});

describe("deleteConversationGently releases the checklist task", () => {
  test("the off-loop path clears the same state as the synchronous one", async () => {
    const taskId = "delete-gently";
    const conversationId = await seedStartedTask(taskId);

    await deleteConversationGently(conversationId);
    await waitFor(() => taskRecord(taskId) === undefined);
  });
});

describe("clearAll releases every checklist task", () => {
  test("started tasks go, finished ones keep their history", async () => {
    await seedStartedTask("clear-all-started");
    await seedDoneTask("clear-all-done");

    await clearAll();
    await waitFor(
      () => readActivationProgress().tasks["clear-all-started"] === undefined,
    );

    expect(taskRecord("clear-all-done")).toMatchObject({
      status: "done",
      stepCount: 2,
      conversationId: "",
    });
  });
});

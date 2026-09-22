/**
 * Deleting a conversation drops the sends deferred against it.
 *
 * A deferred send lives outside the conversation and outlives its teardown, so
 * without the delete cancelling it the send is admitted the moment the lock
 * frees, persists its message, and writes the deleted conversation's row back.
 */
import { beforeEach, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: async () => 0,
  denyPendingConfirmationsOnSupersession: () => {},
  resolveMetaSlashCommand: () => null,
  switchConversation: async () => null,
  undoLastMessage: async () => null,
}));

import type { Conversation } from "../daemon/conversation.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

const { addMessage, createConversation, getConversation } =
  await import("../persistence/conversation-crud.js");
const {
  __resetConversationAdmissionForTests,
  isAdmissionCancelledError,
  pendingAdmissionCount,
  runWhenConversationIdle,
} = await import("../daemon/conversation-admission.js");
const { clearConversations, setConversation } =
  await import("../daemon/conversation-registry.js");
const { ROUTES } =
  await import("../runtime/routes/conversation-management-routes.js");

const deleteRoute = ROUTES.find((r) => r.operationId === "deleteConversation")!;

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The slice of `Conversation` the admission gate and the delete teardown read:
 * the processing flag, the event-driven idle wait, and `dispose`.
 */
function registerBusyConversation(conversationId: string): {
  release: () => void;
} {
  let processing = true;
  const idleWaiters = new Set<() => void>();
  const release = (): void => {
    processing = false;
    for (const notify of [...idleWaiters]) {
      notify();
    }
  };
  const fake = {
    isProcessing: () => processing,
    waitForIdle: () =>
      new Promise<boolean>((resolve) => {
        if (!processing) {
          resolve(true);
          return;
        }
        idleWaiters.add(() => resolve(true));
      }),
    dispose: () => {},
  };
  setConversation(conversationId, fake as unknown as Conversation);
  return { release };
}

beforeEach(() => {
  __resetConversationAdmissionForTests();
  clearConversations();
});

test("a send waiting on a deleted conversation never runs and never recreates its row", async () => {
  const conversation = createConversation("deferred-send-delete");
  const { release } = registerBusyConversation(conversation.id);

  let ran = false;
  const admitted = runWhenConversationIdle(
    conversation.id,
    async () => {
      ran = true;
      await addMessage(conversation.id, "user", "the deferred message");
    },
    { origin: "channel" },
  ).then(
    (value) => value,
    (err: unknown) => err,
  );

  await tick();
  expect(ran).toBe(false);
  expect(pendingAdmissionCount(conversation.id)).toBe(1);

  await deleteRoute.handler({
    pathParams: { id: conversation.id },
    body: {},
    headers: {},
  } as Parameters<typeof deleteRoute.handler>[0]);

  expect(getConversation(conversation.id)).toBeNull();
  expect(isAdmissionCancelledError(await admitted)).toBe(true);
  expect(pendingAdmissionCount(conversation.id)).toBe(0);

  // The turn the send was waiting on finishing afterwards must not admit it.
  release();
  await tick();
  expect(ran).toBe(false);
  expect(getConversation(conversation.id)).toBeNull();
});

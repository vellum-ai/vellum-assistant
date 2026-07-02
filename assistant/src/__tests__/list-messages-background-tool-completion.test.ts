/**
 * Tests for handleListMessages background-tool completion projection.
 *
 * A backgrounded bash/host_bash run posts a `<background_event
 * source="background-tool">` wake on completion, stamped with
 * `metadata.backgroundToolCompletion`. The history projection must surface
 * that structured record (and the `backgroundEventNotification` flag) so the
 * web can rebuild a terminal inline card after a daemon restart.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import { ConversationMessageSchema } from "../api/responses/conversation-message.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

interface ProjectedMessage {
  role: string;
  backgroundEventNotification?: boolean;
  backgroundToolCompletion?: Record<string, unknown>;
}

describe("handleListMessages background-tool completion projection", () => {
  beforeEach(resetTables);

  test("projects backgroundToolCompletion from the wake row metadata", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "run a long command" }]),
    );

    const completion = {
      id: "bg-1",
      toolName: "bash",
      conversationId: conv.id,
      command: "sleep 5 && echo done",
      startedAt: 1000,
      status: "completed" as const,
      exitCode: 0,
      output: "done\n",
      completedAt: 2000,
    };
    // Mirror persistWakeTriggerMessage: a user-role
    // `<background_event source="background-tool">` row carrying the structured
    // completion. The client suppresses it from the transcript via
    // `backgroundEventNotification`.
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        {
          type: "text",
          text: '<background_event source="background-tool">Background command completed (id=bg-1, exit=0):</background_event>',
        },
      ]),
      {
        metadata: {
          kind: "background-event",
          backgroundEventSource: "background-tool",
          automated: true,
          backgroundToolCompletion: completion,
        },
      },
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    }) as { messages: ProjectedMessage[] };

    // Every projected message validates against the wire schema.
    for (const message of response.messages) {
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }

    const wakeRow = response.messages.find(
      (m) => m.backgroundToolCompletion !== undefined,
    );
    expect(wakeRow).toBeDefined();
    expect(wakeRow?.backgroundEventNotification).toBe(true);
    expect(wakeRow?.backgroundToolCompletion).toEqual(completion);
  });

  test("omits backgroundToolCompletion when the row carries no completion metadata", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "hi there" }]),
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    }) as { messages: ProjectedMessage[] };

    expect(response.messages).toHaveLength(2);
    for (const message of response.messages) {
      expect(message.backgroundToolCompletion).toBeUndefined();
      expect(message.backgroundEventNotification).toBeUndefined();
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }
  });
});

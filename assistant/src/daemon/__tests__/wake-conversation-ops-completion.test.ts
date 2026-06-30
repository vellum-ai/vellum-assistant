import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// persistWakeTriggerMessage syncs each row to the disk view and publishes a
// sync invalidation; stub both so this unit test stays a pure DB round-trip
// without touching the filesystem or the event hub.
mock.module("../../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));
mock.module("../../runtime/sync/resource-sync-events.js", () => ({
  publishConversationMessagesChanged: () => {},
}));

import {
  createConversation,
  getMessages,
} from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { Message } from "../../providers/types.js";
import type { CompletedBackgroundTool } from "../../tools/background-tool-registry.js";
import type { Conversation } from "../conversation.js";
import { persistWakeTriggerMessage } from "../wake-conversation-ops.js";

await initializeDb();

/** Minimal Conversation stub exercising only the fields the function reads. */
function makeConversationStub(conversationId: string): Conversation {
  return {
    conversationId,
    trustContext: undefined,
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  } as unknown as Conversation;
}

function triggerMessage(): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: '<background_event source="background-tool">Background command completed (id=bg-1, exit=0):</background_event>',
      },
    ],
  };
}

function readMetadata(conversationId: string): Record<string, unknown> {
  const rows = getMessages(conversationId);
  expect(rows.length).toBe(1);
  const raw = rows[0]?.metadata;
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe("persistWakeTriggerMessage backgroundToolCompletion", () => {
  let conversationId: string;

  beforeEach(() => {
    conversationId = createConversation("wake-completion-test").id;
  });

  test("round-trips a completion onto the persisted metadata", async () => {
    const completion: CompletedBackgroundTool = {
      id: "bg-1",
      toolName: "bash",
      conversationId,
      command: "sleep 1 && echo done",
      startedAt: 1_700_000_000_000,
      status: "completed",
      exitCode: 0,
      output: "done\n",
      completedAt: 1_700_000_001_000,
    };

    await persistWakeTriggerMessage(
      makeConversationStub(conversationId),
      triggerMessage(),
      "background-tool",
      completion,
    );

    const metadata = readMetadata(conversationId);
    expect(metadata.backgroundToolCompletion).toEqual(completion);
    // Existing wake-trigger metadata is unaffected.
    expect(metadata.kind).toBe("background-event");
    expect(metadata.backgroundEventSource).toBe("background-tool");
    expect(metadata.automated).toBe(true);
  });

  test("omits the key entirely when no completion is passed", async () => {
    await persistWakeTriggerMessage(
      makeConversationStub(conversationId),
      triggerMessage(),
      "background-tool",
    );

    const metadata = readMetadata(conversationId);
    expect("backgroundToolCompletion" in metadata).toBe(false);
    expect(metadata.kind).toBe("background-event");
  });
});

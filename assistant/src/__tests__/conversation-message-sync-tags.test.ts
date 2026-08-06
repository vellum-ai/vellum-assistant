import { describe, expect, test } from "bun:test";

import type { AssistantEventEnvelope } from "../api/index.js";
import {
  conversationMessagesSyncTag,
  type SyncChangedEvent,
} from "../daemon/message-types/sync.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { waitFor } from "./helpers/wait-for.js";

async function captureEvents(
  action: () => void | Promise<unknown>,
  expectedCount: number,
): Promise<AssistantEventEnvelope[]> {
  const received: AssistantEventEnvelope[] = [];
  const subscription = assistantEventHub.subscribe({
    type: "process",
    callback: (event) => {
      received.push(event);
    },
  });
  try {
    await action();
    await waitFor(() => received.length >= expectedCount, {
      message: "Timed out waiting for conversation message sync tag event",
    });
    return received;
  } finally {
    subscription.dispose();
  }
}

function syncMessages(events: AssistantEventEnvelope[]): SyncChangedEvent[] {
  return events
    .map((event) => event.message)
    .filter(
      (message): message is SyncChangedEvent => message.type === "sync_changed",
    );
}

describe("conversation message sync tags", () => {
  test("message-history publisher emits the conversation messages tag", async () => {
    const received = await captureEvents(() => {
      publishConversationMessagesChanged("conversation-123");
    }, 1);

    expect(syncMessages(received)).toEqual([
      {
        type: "sync_changed",
        tags: [conversationMessagesSyncTag("conversation-123")],
      },
    ]);
  });

  test("callers can sequence user echo before the message-history tag", async () => {
    const received = await captureEvents(() => {
      broadcastMessage({
        type: "user_message_echo",
        conversationId: "conversation-123",
        text: "Hello from another client",
        messageId: "message-123",
      });
      publishConversationMessagesChanged("conversation-123");
    }, 2);

    expect(received.map((event) => event.message.type)).toEqual([
      "user_message_echo",
      "sync_changed",
    ]);
    expect(syncMessages(received)).toEqual([
      {
        type: "sync_changed",
        tags: [conversationMessagesSyncTag("conversation-123")],
      },
    ]);
  });

  test("token deltas do not emit message-history sync tags", async () => {
    const received = await captureEvents(() => {
      broadcastMessage({
        type: "assistant_text_delta",
        conversationId: "conversation-123",
        text: "partial",
      });
    }, 1);

    expect(received.map((event) => event.message.type)).toEqual([
      "assistant_text_delta",
    ]);
    expect(syncMessages(received)).toEqual([]);
  });
});

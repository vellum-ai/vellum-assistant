import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../daemon/message-types/sync.js";
import {
  createConversation,
  getConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { upsertBinding } from "../persistence/external-conversation-store.js";
import { getModelProfiles } from "../plugin-api/model-profiles.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import { TELEGRAM_TOPIC_ROUTES } from "../runtime/routes/telegram-topic-routes.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { waitFor } from "./helpers/wait-for.js";

await initializeDb();

const setProfileRoute = TELEGRAM_TOPIC_ROUTES.find(
  (r) => r.operationId === "telegram_set_profile",
)!;

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function firstEnabledProfileKey(): string {
  const profile = getModelProfiles().find((entry) => !entry.isDisabled);
  if (!profile) {
    throw new Error("expected at least one enabled model profile");
  }
  return profile.key;
}

describe("POST /v1/channels/telegram/profiles/set", () => {
  beforeEach(() => {
    clearTables();
  });

  afterAll(() => {
    resetDbForTesting();
  });

  test("persists the profile and broadcasts an inference-profile update", async () => {
    const conversation = createConversation("tg-set-profile");
    upsertBinding({
      conversationId: conversation.id,
      sourceChannel: "telegram",
      externalChatId: "tg-chat",
      externalThreadId: "777",
    });
    const profileKey = firstEnabledProfileKey();

    const received: Array<{
      type: string;
      conversationId?: string;
      profile?: string | null;
      tags?: string[];
    }> = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push({
          type: event.message.type,
          conversationId: event.conversationId,
          profile:
            event.message.type === "conversation_inference_profile_updated"
              ? event.message.profile
              : undefined,
          tags:
            event.message.type === "sync_changed"
              ? event.message.tags
              : undefined,
        });
      },
    });

    const result = await setProfileRoute.handler({
      body: { chatId: "tg-chat", threadId: "777", profile: profileKey },
      headers: {},
    });

    await waitFor(() => received.length === 2, {
      message: "Timed out waiting for Telegram set-profile events",
    });

    expect(result).toMatchObject({ ok: true, profile: profileKey });
    expect(getConversation(conversation.id)?.inferenceProfile).toBe(profileKey);
    expect(received).toEqual([
      {
        type: "conversation_inference_profile_updated",
        conversationId: conversation.id,
        profile: profileKey,
        tags: undefined,
      },
      {
        type: "sync_changed",
        conversationId: undefined,
        profile: undefined,
        tags: [
          SYNC_TAGS.conversationsList,
          conversationMetadataSyncTag(conversation.id),
        ],
      },
    ]);

    subscription.dispose();
  });

  test("rejects an unknown profile without touching the conversation", async () => {
    const conversation = createConversation("tg-set-profile-unknown");
    upsertBinding({
      conversationId: conversation.id,
      sourceChannel: "telegram",
      externalChatId: "tg-chat",
      externalThreadId: "777",
    });

    expect(() =>
      setProfileRoute.handler({
        body: { chatId: "tg-chat", threadId: "777", profile: "does-not-exist" },
        headers: {},
      }),
    ).toThrow(BadRequestError);
    expect(getConversation(conversation.id)?.inferenceProfile).toBeNull();
  });

  test("throws NotFoundError when no conversation is bound to the topic", () => {
    expect(() =>
      setProfileRoute.handler({
        body: {
          chatId: "tg-chat",
          threadId: "777",
          profile: firstEnabledProfileKey(),
        },
        headers: {},
      }),
    ).toThrow(NotFoundError);
  });
});

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const config = {
  llm: {
    profiles: {
      "quality-optimized": {},
      balanced: {},
      "cost-optimized": {},
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => config,
  getConfig: () => config,
}));

import {
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";

initializeDb();

const profileRoute = ROUTES.find(
  (r) => r.operationId === "setConversationInferenceProfile",
)!;

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM conversation_assistant_attention_state");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("PUT /v1/conversations/:id/inference-profile", () => {
  beforeEach(() => {
    clearTables();
  });

  afterAll(() => {
    resetDb();
    mock.restore();
  });

  test("sets the override and emits a hub event for a known profile", async () => {
    const conversation = createConversation("inference-profile-route");

    const received: Array<{
      type: string;
      conversationId?: string;
      profile?: string | null;
    }> = [];
    const subscription = assistantEventHub.subscribe({}, (event) => {
      received.push({
        type: event.message.type,
        conversationId: event.conversationId,
        profile:
          event.message.type === "conversation_inference_profile_updated"
            ? event.message.profile
            : undefined,
      });
    });

    const result = profileRoute.handler({
      pathParams: { id: conversation.id },
      body: { profile: "quality-optimized" },
      headers: {},
    });

    await Promise.resolve();

    expect(result).toEqual({
      conversationId: conversation.id,
      profile: "quality-optimized",
    });
    expect(getConversation(conversation.id)?.inferenceProfile).toBe(
      "quality-optimized",
    );
    expect(received).toEqual([
      {
        type: "conversation_inference_profile_updated",
        conversationId: conversation.id,
        profile: "quality-optimized",
      },
    ]);

    subscription.dispose();
  });

  test("rejects unknown profile names with BadRequestError", () => {
    const conversation = createConversation("inference-profile-unknown");

    expect(() =>
      profileRoute.handler({
        pathParams: { id: conversation.id },
        body: { profile: "does-not-exist" },
        headers: {},
      }),
    ).toThrow(BadRequestError);
    expect(getConversation(conversation.id)?.inferenceProfile).toBeNull();
  });

  test("clears the override when profile is null", async () => {
    const conversation = createConversation("inference-profile-clear");

    profileRoute.handler({
      pathParams: { id: conversation.id },
      body: { profile: "balanced" },
      headers: {},
    });
    expect(getConversation(conversation.id)?.inferenceProfile).toBe("balanced");

    const received: Array<{ profile?: string | null }> = [];
    const subscription = assistantEventHub.subscribe({}, (event) => {
      if (event.message.type === "conversation_inference_profile_updated") {
        received.push({ profile: event.message.profile });
      }
    });

    const result = profileRoute.handler({
      pathParams: { id: conversation.id },
      body: { profile: null },
      headers: {},
    });

    await Promise.resolve();

    expect(result).toEqual({
      conversationId: conversation.id,
      profile: null,
    });
    expect(getConversation(conversation.id)?.inferenceProfile).toBeNull();
    expect(received).toEqual([{ profile: null }]);

    subscription.dispose();
  });

  test("skips write and event when the profile is unchanged", async () => {
    const conversation = createConversation("inference-profile-noop");

    profileRoute.handler({
      pathParams: { id: conversation.id },
      body: { profile: "balanced" },
      headers: {},
    });
    const updatedAtAfterSet = getConversation(conversation.id)?.updatedAt;

    const received: Array<{ profile?: string | null }> = [];
    const subscription = assistantEventHub.subscribe({}, (event) => {
      if (event.message.type === "conversation_inference_profile_updated") {
        received.push({ profile: event.message.profile });
      }
    });

    const result = profileRoute.handler({
      pathParams: { id: conversation.id },
      body: { profile: "balanced" },
      headers: {},
    });

    await Promise.resolve();

    expect(result).toEqual({
      conversationId: conversation.id,
      profile: "balanced",
    });
    expect(getConversation(conversation.id)?.updatedAt).toBe(updatedAtAfterSet);
    expect(received).toEqual([]);

    subscription.dispose();
  });

  test("throws NotFoundError when the conversation does not exist", () => {
    expect(() =>
      profileRoute.handler({
        pathParams: { id: "missing" },
        body: { profile: "balanced" },
        headers: {},
      }),
    ).toThrow(NotFoundError);
  });
});

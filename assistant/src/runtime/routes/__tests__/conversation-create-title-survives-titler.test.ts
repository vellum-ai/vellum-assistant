/**
 * A title given when a conversation is created is user-set: the automatic
 * titler must never replace it, neither on the first turn nor on the
 * later re-title pass. Drives the real create and rename route handlers and
 * the real title service against a real database; only the LLM provider is a
 * stub.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

import { eq } from "drizzle-orm";

import {
  addMessage,
  getConversation,
} from "../../../persistence/conversation-crud.js";
import {
  generateAndPersistConversationTitle,
  regenerateConversationTitle,
} from "../../../persistence/conversation-title-service.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { conversations } from "../../../persistence/schema/index.js";
import type { Provider } from "../../../providers/types.js";
import { ROUTES as CONVERSATION_CLI_ROUTES } from "../conversation-cli-routes.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../conversation-management-routes.js";
import { ROUTES as RENAME_CONVERSATION_ROUTES } from "../rename-conversation-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

await initializeDb();

const GENERATED_TITLE = "Build Queue Status";

function makeTitleProvider() {
  const sendMessage = mock(async () => ({
    content: [
      {
        type: "tool_use",
        id: "toolu_title",
        name: "record_conversation_title",
        input: { title: GENERATED_TITLE },
      },
    ],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  }));
  return {
    provider: { name: "test-provider", sendMessage } as unknown as Provider,
    sendMessage,
  };
}

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const createCliHandler = findHandler(
  CONVERSATION_CLI_ROUTES,
  "conversation_create_cli",
);
const createHttpHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "createConversation",
);
const renameHandler = findHandler(
  RENAME_CONVERSATION_ROUTES,
  "rename_conversation",
);

type CreatePath = {
  name: string;
  create: (title?: string) => Promise<string>;
};

const CREATE_PATHS: CreatePath[] = [
  {
    name: "CLI create (`assistant conversations new`)",
    create: async (title) => {
      const result = (await createCliHandler({
        body: { title, messages: [] },
      } as RouteHandlerArgs)) as { id: string };
      return result.id;
    },
  },
  {
    name: "HTTP create (POST /v1/conversations)",
    create: async (title) => {
      const result = (await createHttpHandler({
        body: { conversationType: "standard", title },
      } as RouteHandlerArgs)) as { id: string };
      return result.id;
    },
  },
];

async function seedTurns(conversationId: string, turns: number) {
  for (let i = 1; i <= turns; i++) {
    await addMessage(
      conversationId,
      "user",
      JSON.stringify([{ type: "text", text: `Check the build queue ${i}` }]),
    );
    await addMessage(
      conversationId,
      "assistant",
      JSON.stringify([{ type: "text", text: `Queue is clear ${i}` }]),
    );
  }
}

function readTitle(conversationId: string) {
  return getDb()
    .select({
      title: conversations.title,
      isAutoTitle: conversations.isAutoTitle,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
}

beforeEach(() => {
  getDb().delete(conversations).run();
});

for (const path of CREATE_PATHS) {
  describe(path.name, () => {
    test("an explicit title survives the first-turn titler", async () => {
      const conversationId = await path.create("Research notes");
      const { provider, sendMessage } = makeTitleProvider();

      const result = await generateAndPersistConversationTitle({
        conversationId,
        provider,
        userMessage: "Check the build queue",
      });

      expect(result.updated).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(readTitle(conversationId)?.title).toBe("Research notes");
    });

    test("an explicit title survives the re-title pass", async () => {
      const conversationId = await path.create("Research notes");
      await seedTurns(conversationId, 3);
      const { provider, sendMessage } = makeTitleProvider();

      const result = await regenerateConversationTitle({
        conversationId,
        provider,
      });

      expect(result.updated).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(readTitle(conversationId)).toEqual({
        title: "Research notes",
        isAutoTitle: 0,
      });
    });

    test("an explicit title that matches a placeholder is kept", async () => {
      const conversationId = await path.create("New Conversation");
      const { provider, sendMessage } = makeTitleProvider();

      await generateAndPersistConversationTitle({
        conversationId,
        provider,
        userMessage: "Check the build queue",
      });
      // An empty prompt takes the deterministic fallback path.
      await generateAndPersistConversationTitle({ conversationId, provider });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(readTitle(conversationId)).toEqual({
        title: "New Conversation",
        isAutoTitle: 0,
      });
    });

    test("an untitled conversation is still auto-titled", async () => {
      const conversationId = await path.create();
      const { provider, sendMessage } = makeTitleProvider();

      const result = await generateAndPersistConversationTitle({
        conversationId,
        provider,
        userMessage: "Check the build queue",
      });

      expect(result.updated).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(readTitle(conversationId)?.title).toBe(GENERATED_TITLE);
    });

    test("a blank title is treated as untitled", async () => {
      const conversationId = await path.create("   ");
      await seedTurns(conversationId, 3);
      const { provider } = makeTitleProvider();

      const result = await regenerateConversationTitle({
        conversationId,
        provider,
      });

      expect(result.updated).toBe(true);
      expect(readTitle(conversationId)?.title).toBe(GENERATED_TITLE);
    });
  });
}

describe("rename", () => {
  test("a renamed auto-titled conversation survives the re-title pass", async () => {
    const conversationId = await CREATE_PATHS[0]!.create();
    await seedTurns(conversationId, 3);
    const { provider } = makeTitleProvider();
    await generateAndPersistConversationTitle({
      conversationId,
      provider,
      userMessage: "Check the build queue",
    });
    expect(getConversation(conversationId)?.title).toBe(GENERATED_TITLE);

    await renameHandler({
      body: { conversationId, title: "Renamed by hand" },
    } as RouteHandlerArgs);
    const second = makeTitleProvider();
    const result = await regenerateConversationTitle({
      conversationId,
      provider: second.provider,
    });

    expect(result.updated).toBe(false);
    expect(second.sendMessage).not.toHaveBeenCalled();
    expect(readTitle(conversationId)).toEqual({
      title: "Renamed by hand",
      isAutoTitle: 0,
    });
  });
});

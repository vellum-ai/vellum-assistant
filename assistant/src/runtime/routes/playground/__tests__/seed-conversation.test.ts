import { describe, expect, mock, test } from "bun:test";

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({}),
}));

type AddMessageArgs = [
  string,
  "user" | "assistant",
  string,
  { skipIndexing?: boolean } | undefined,
];

const createdTitles: string[] = [];
const addedMessages: AddMessageArgs[] = [];
let _nextConvId = 0;
let _nextMessageId = 0;

mock.module("../helpers.js", () => ({
  getConversationById: async () => undefined,
  listConversationsByTitlePrefix: () => [],
  deleteConversationById: () => false,
  createPlaygroundConversation: (title: string) => {
    createdTitles.push(title);
    return { id: `conv-${++_nextConvId}` };
  },
  addPlaygroundMessage: async (
    conversationId: string,
    role: "user" | "assistant",
    contentJson: string,
    options?: { skipIndexing?: boolean },
  ) => {
    addedMessages.push([conversationId, role, contentJson, options]);
    return { id: `msg-${++_nextMessageId}` };
  },
}));

import { RouteError } from "../../errors.js";
import { ROUTES } from "../index.js";
import { PLAYGROUND_TITLE_PREFIX } from "../seed-conversation.js";

function findRoute() {
  const route = ROUTES.find(
    (r) => r.operationId === "playgroundSeedConversation",
  );
  if (!route) throw new Error("seed-conversation route not registered");
  return route;
}

function resetSpies() {
  createdTitles.length = 0;
  addedMessages.length = 0;
  _nextConvId = 0;
  _nextMessageId = 0;
}

describe("POST /v1/playground/seed-conversation", () => {
  test("seeds N turns as 2N messages and returns conversation id", async () => {
    resetSpies();
    const body = (await findRoute().handler({
      body: { turns: 5, avgTokensPerTurn: 500 },
    })) as {
      conversationId: string;
      messagesInserted: number;
      estimatedTokens: number;
    };

    expect(body.conversationId).toBe("conv-1");
    expect(body.messagesInserted).toBe(10);
    expect(createdTitles).toHaveLength(1);
    expect(addedMessages).toHaveLength(10);

    for (let i = 0; i < addedMessages.length; i++) {
      const [convId, role, contentJson, options] = addedMessages[i];
      expect(convId).toBe("conv-1");
      expect(role).toBe(i % 2 === 0 ? "user" : "assistant");
      const parsed = JSON.parse(contentJson) as Array<{
        type: string;
        text: string;
      }>;
      expect(parsed[0].type).toBe("text");
      expect(parsed[0].text.length).toBeGreaterThan(0);
      expect(options?.skipIndexing).toBe(true);
    }
  });

  test("returns a positive estimated token count", async () => {
    resetSpies();
    const body = (await findRoute().handler({
      body: { turns: 5, avgTokensPerTurn: 500 },
    })) as { estimatedTokens: number };
    expect(body.estimatedTokens).toBeGreaterThan(0);
  });

  test("throws BadRequestError for turns: 0", async () => {
    try {
      await findRoute().handler({ body: { turns: 0 } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }
  });

  test("throws BadRequestError for turns: 501 (above max)", async () => {
    try {
      await findRoute().handler({ body: { turns: 501 } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }
  });

  test("throws BadRequestError for negative avgTokensPerTurn", async () => {
    try {
      await findRoute().handler({
        body: { turns: 2, avgTokensPerTurn: -1 },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }
  });

  test("prepends [Playground] prefix to a plain title", async () => {
    resetSpies();
    await findRoute().handler({ body: { turns: 1, title: "My test" } });
    expect(createdTitles[0]).toBe(`${PLAYGROUND_TITLE_PREFIX}My test`);
  });

  test("does not double up when the title already starts with the prefix", async () => {
    resetSpies();
    await findRoute().handler({
      body: { turns: 1, title: `${PLAYGROUND_TITLE_PREFIX}existing` },
    });
    expect(createdTitles[0]).toBe(`${PLAYGROUND_TITLE_PREFIX}existing`);
  });

  test("falls back to an ISO timestamp title when none is supplied", async () => {
    resetSpies();
    await findRoute().handler({ body: { turns: 1 } });

    const created = createdTitles[0];
    expect(created).toMatch(
      new RegExp(
        `^${PLAYGROUND_TITLE_PREFIX.replace(
          /[[\]]/g,
          "\\$&",
        )}\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$`,
      ),
    );
  });
});

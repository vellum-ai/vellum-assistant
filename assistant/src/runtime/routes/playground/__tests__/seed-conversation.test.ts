import { describe, expect, test } from "bun:test";

import type { Conversation } from "../../../../daemon/conversation.js";
import type { RouteDefinition } from "../../../http-router.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import {
  PLAYGROUND_TITLE_PREFIX,
  seedConversationRouteDefinitions,
} from "../seed-conversation.js";

type AddMessageArgs = [string, "user" | "assistant", string];

interface Spy {
  deps: PlaygroundRouteDeps;
  createdTitles: string[];
  addedMessages: AddMessageArgs[];
}

function makeDeps(overrides?: { enabled?: boolean }): Spy {
  const createdTitles: string[] = [];
  const addedMessages: AddMessageArgs[] = [];
  let nextConvId = 0;
  let nextMessageId = 0;

  const deps: PlaygroundRouteDeps = {
    getConversationById: (_id: string): Conversation | undefined => undefined,
    isPlaygroundEnabled: () => overrides?.enabled ?? true,
    listConversationsByTitlePrefix: () => [],
    deleteConversationById: () => false,
    createConversation: async (title) => {
      createdTitles.push(title);
      return { id: `conv-${++nextConvId}` };
    },
    addMessage: async (conversationId, role, contentJson) => {
      addedMessages.push([conversationId, role, contentJson]);
      return { id: `msg-${++nextMessageId}` };
    },
  };
  return { deps, createdTitles, addedMessages };
}

function getSeedHandler(deps: PlaygroundRouteDeps): RouteDefinition["handler"] {
  const routes = seedConversationRouteDefinitions(deps);
  const route = routes.find(
    (r) => r.endpoint === "playground/seed-conversation" && r.method === "POST",
  );
  if (!route) throw new Error("seed-conversation route not registered");
  return route.handler;
}

function makeCtx(body: unknown) {
  const url = new URL("http://localhost/v1/playground/seed-conversation");
  return {
    url,
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {} as never,
    params: {},
  };
}

describe("POST /v1/playground/seed-conversation", () => {
  test("returns 404 when the playground flag is disabled", async () => {
    const { deps } = makeDeps({ enabled: false });
    const handler = getSeedHandler(deps);

    const res = await handler(makeCtx({ turns: 3 }));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("seeds N turns as 2N messages and returns conversation id", async () => {
    const spy = makeDeps();
    const handler = getSeedHandler(spy.deps);

    const res = await handler(makeCtx({ turns: 5, avgTokensPerTurn: 500 }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      conversationId: string;
      messagesInserted: number;
      estimatedTokens: number;
    };
    expect(body.conversationId).toBe("conv-1");
    expect(body.messagesInserted).toBe(10);
    expect(spy.createdTitles).toHaveLength(1);
    expect(spy.addedMessages).toHaveLength(10);

    // Roles alternate user/assistant across the 10 inserted messages.
    for (let i = 0; i < spy.addedMessages.length; i++) {
      const [convId, role, contentJson] = spy.addedMessages[i];
      expect(convId).toBe("conv-1");
      expect(role).toBe(i % 2 === 0 ? "user" : "assistant");
      // Content is a JSON-encoded array of blocks matching the in-memory
      // Message[] shape the rest of the daemon expects.
      const parsed = JSON.parse(contentJson) as Array<{
        type: string;
        text: string;
      }>;
      expect(parsed[0].type).toBe("text");
      expect(parsed[0].text.length).toBeGreaterThan(0);
    }
  });

  test("returns a positive estimated token count", async () => {
    const spy = makeDeps();
    const handler = getSeedHandler(spy.deps);

    const res = await handler(makeCtx({ turns: 5, avgTokensPerTurn: 500 }));
    expect(res.status).toBe(200);

    // We intentionally don't assert tight bounds: sibling playground tests
    // call `mock.module(".../token-estimator.js", ...)` at module scope,
    // and Bun persists that mock across files in the same test run. All we
    // can safely assert is that some positive estimate was produced — the
    // exact value is exercised by the estimator's own tests.
    const body = (await res.json()) as { estimatedTokens: number };
    expect(body.estimatedTokens).toBeGreaterThan(0);
  });

  test("rejects turns: 0", async () => {
    const { deps } = makeDeps();
    const handler = getSeedHandler(deps);
    const res = await handler(makeCtx({ turns: 0 }));
    expect(res.status).toBe(400);
  });

  test("rejects turns: 501 (above max)", async () => {
    const { deps } = makeDeps();
    const handler = getSeedHandler(deps);
    const res = await handler(makeCtx({ turns: 501 }));
    expect(res.status).toBe(400);
  });

  test("rejects negative avgTokensPerTurn", async () => {
    const { deps } = makeDeps();
    const handler = getSeedHandler(deps);
    const res = await handler(makeCtx({ turns: 2, avgTokensPerTurn: -1 }));
    expect(res.status).toBe(400);
  });

  test("prepends [Playground] prefix to a plain title", async () => {
    const spy = makeDeps();
    const handler = getSeedHandler(spy.deps);

    const res = await handler(makeCtx({ turns: 1, title: "My test" }));
    expect(res.status).toBe(200);
    expect(spy.createdTitles[0]).toBe(`${PLAYGROUND_TITLE_PREFIX}My test`);
  });

  test("does not double up when the title already starts with the prefix", async () => {
    const spy = makeDeps();
    const handler = getSeedHandler(spy.deps);

    const res = await handler(
      makeCtx({
        turns: 1,
        title: `${PLAYGROUND_TITLE_PREFIX}existing`,
      }),
    );
    expect(res.status).toBe(200);
    expect(spy.createdTitles[0]).toBe(`${PLAYGROUND_TITLE_PREFIX}existing`);
  });

  test("falls back to an ISO timestamp title when none is supplied", async () => {
    const spy = makeDeps();
    const handler = getSeedHandler(spy.deps);

    const res = await handler(makeCtx({ turns: 1 }));
    expect(res.status).toBe(200);

    const created = spy.createdTitles[0];
    // Pattern: "[Playground] YYYY-MM-DDTHH:MM:SS"
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

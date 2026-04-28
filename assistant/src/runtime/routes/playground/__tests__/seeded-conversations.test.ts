import { describe, expect, mock, test } from "bun:test";

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({}),
}));

let _listRows: Array<{
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
}> = [];

const listCalls: string[] = [];
const deleteCalls: string[] = [];
let _deleteReturn: boolean | ((id: string) => boolean) = true;

mock.module("../helpers.js", () => ({
  getConversationById: async () => undefined,
  listConversationsByTitlePrefix: (prefix: string) => {
    listCalls.push(prefix);
    return _listRows;
  },
  deleteConversationById: (id: string) => {
    deleteCalls.push(id);
    return typeof _deleteReturn === "function" ? _deleteReturn(id) : _deleteReturn;
  },
  createPlaygroundConversation: () => ({ id: "conv-test" }),
  addPlaygroundMessage: async () => ({ id: "msg-test" }),
}));

import { RouteError } from "../../errors.js";
import { ROUTES } from "../index.js";
import { PLAYGROUND_TITLE_PREFIX } from "../seed-conversation.js";

function resetSpies() {
  listCalls.length = 0;
  deleteCalls.length = 0;
  _listRows = [];
  _deleteReturn = true;
}

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not registered`);
  return route;
}

describe("GET playground/seeded-conversations", () => {
  test("forwards the prefix to the helper and returns the rows verbatim", async () => {
    resetSpies();
    _listRows = [
      {
        id: "conv-1",
        title: `${PLAYGROUND_TITLE_PREFIX}First`,
        messageCount: 4,
        createdAt: 2000,
      },
      {
        id: "conv-2",
        title: `${PLAYGROUND_TITLE_PREFIX}Second`,
        messageCount: 2,
        createdAt: 1000,
      },
    ];

    const body = (await findRoute(
      "playgroundListSeededConversations",
    ).handler({})) as { conversations: typeof _listRows };

    expect(body.conversations).toEqual(_listRows);
    expect(listCalls).toEqual([PLAYGROUND_TITLE_PREFIX]);
  });
});

describe("DELETE playground/seeded-conversations/:id", () => {
  test("throws ForbiddenError when the conversation is not in the prefix-filtered set", async () => {
    resetSpies();
    _listRows = [
      {
        id: "other-playground-id",
        title: `${PLAYGROUND_TITLE_PREFIX}Kept`,
        messageCount: 1,
        createdAt: 1,
      },
    ];

    try {
      await findRoute("playgroundDeleteSeededConversation").handler({
        pathParams: { id: "non-playground-conv" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(403);
      expect((err as RouteError).message).toBe("Not a playground conversation");
    }
    expect(deleteCalls).toEqual([]);
  });

  test("returns deletedCount: 1 when the id is a prefix-matching conversation", async () => {
    resetSpies();
    _listRows = [
      {
        id: "conv-seeded",
        title: `${PLAYGROUND_TITLE_PREFIX}Seeded`,
        messageCount: 3,
        createdAt: 5,
      },
    ];

    const body = (await findRoute(
      "playgroundDeleteSeededConversation",
    ).handler({
      pathParams: { id: "conv-seeded" },
    })) as { deletedCount: number };

    expect(body.deletedCount).toBe(1);
    expect(deleteCalls).toEqual(["conv-seeded"]);
  });

  test("returns deletedCount: 0 when deleteConversationById reports a miss", async () => {
    resetSpies();
    _listRows = [
      {
        id: "conv-seeded",
        title: `${PLAYGROUND_TITLE_PREFIX}Seeded`,
        messageCount: 0,
        createdAt: 5,
      },
    ];
    _deleteReturn = false;

    const body = (await findRoute(
      "playgroundDeleteSeededConversation",
    ).handler({
      pathParams: { id: "conv-seeded" },
    })) as { deletedCount: number };

    expect(body.deletedCount).toBe(0);
    expect(deleteCalls).toEqual(["conv-seeded"]);
  });
});

describe("DELETE playground/seeded-conversations (bulk)", () => {
  test("enumerates only prefix-matching rows and calls delete for each", async () => {
    resetSpies();
    _listRows = [
      {
        id: "conv-a",
        title: `${PLAYGROUND_TITLE_PREFIX}A`,
        messageCount: 0,
        createdAt: 3,
      },
      {
        id: "conv-b",
        title: `${PLAYGROUND_TITLE_PREFIX}B`,
        messageCount: 2,
        createdAt: 2,
      },
      {
        id: "conv-c",
        title: `${PLAYGROUND_TITLE_PREFIX}C`,
        messageCount: 5,
        createdAt: 1,
      },
    ];

    const body = (await findRoute(
      "playgroundDeleteAllSeededConversations",
    ).handler({})) as { deletedCount: number };

    expect(body.deletedCount).toBe(3);
    expect(listCalls).toEqual([PLAYGROUND_TITLE_PREFIX]);
    expect(deleteCalls).toEqual(["conv-a", "conv-b", "conv-c"]);
  });

  test("deletedCount reflects only rows where the underlying delete succeeded", async () => {
    resetSpies();
    _listRows = [
      {
        id: "conv-ok",
        title: `${PLAYGROUND_TITLE_PREFIX}Ok`,
        messageCount: 1,
        createdAt: 2,
      },
      {
        id: "conv-missing",
        title: `${PLAYGROUND_TITLE_PREFIX}Missing`,
        messageCount: 0,
        createdAt: 1,
      },
    ];
    _deleteReturn = (id) => id !== "conv-missing";

    const body = (await findRoute(
      "playgroundDeleteAllSeededConversations",
    ).handler({})) as { deletedCount: number };

    expect(body.deletedCount).toBe(1);
    expect(deleteCalls).toEqual(["conv-ok", "conv-missing"]);
  });
});

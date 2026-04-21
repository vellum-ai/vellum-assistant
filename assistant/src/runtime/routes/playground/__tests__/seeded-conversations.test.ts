import { describe, expect, test } from "bun:test";

import type { Conversation } from "../../../../daemon/conversation.js";
import type { RouteDefinition } from "../../../http-router.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import {
  PLAYGROUND_TITLE_PREFIX,
  seededConversationsRouteDefinitions,
} from "../seeded-conversations.js";

interface StubOpts {
  enabled?: boolean;
  listRows?: Array<{
    id: string;
    title: string;
    messageCount: number;
    createdAt: number;
  }>;
  getConversationById?: (id: string) => Conversation | undefined;
  deleteReturn?: boolean | ((id: string) => boolean);
}

interface Stub {
  deps: PlaygroundRouteDeps;
  listCalls: string[];
  deleteCalls: string[];
}

function makeStub(opts: StubOpts = {}): Stub {
  const listCalls: string[] = [];
  const deleteCalls: string[] = [];
  const deleteReturn = opts.deleteReturn ?? true;
  const deps: PlaygroundRouteDeps = {
    isPlaygroundEnabled: () => opts.enabled ?? true,
    getConversationById: opts.getConversationById ?? (() => undefined),
    listConversationsByTitlePrefix: (prefix) => {
      listCalls.push(prefix);
      return opts.listRows ?? [];
    },
    deleteConversationById: (id) => {
      deleteCalls.push(id);
      return typeof deleteReturn === "function"
        ? deleteReturn(id)
        : deleteReturn;
    },
  };
  return { deps, listCalls, deleteCalls };
}

function findRoute(
  routes: RouteDefinition[],
  method: string,
  endpoint: string,
): RouteDefinition {
  const match = routes.find(
    (r) => r.method === method && r.endpoint === endpoint,
  );
  if (!match) {
    throw new Error(`Expected route ${method} ${endpoint} not found`);
  }
  return match;
}

// Minimal stand-in for the handler context — the seeded-conversation
// handlers only read `params`, so we only populate that.
function ctx(params: Record<string, string> = {}) {
  return { params } as unknown as Parameters<RouteDefinition["handler"]>[0];
}

describe("seededConversationsRouteDefinitions — flag disabled", () => {
  test("GET list returns 404 when the playground flag is off", async () => {
    const { deps, listCalls } = makeStub({ enabled: false });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(routes, "GET", "playground/seeded-conversations");

    const res = await route.handler(ctx());

    expect(res.status).toBe(404);
    expect(listCalls).toEqual([]);
  });

  test("DELETE single returns 404 when the playground flag is off", async () => {
    const { deps, deleteCalls } = makeStub({ enabled: false });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(
      routes,
      "DELETE",
      "playground/seeded-conversations/:id",
    );

    const res = await route.handler(ctx({ id: "conv-1" }));

    expect(res.status).toBe(404);
    expect(deleteCalls).toEqual([]);
  });

  test("DELETE bulk returns 404 when the playground flag is off", async () => {
    const { deps, listCalls, deleteCalls } = makeStub({ enabled: false });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(
      routes,
      "DELETE",
      "playground/seeded-conversations",
    );

    const res = await route.handler(ctx());

    expect(res.status).toBe(404);
    expect(listCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });
});

describe("GET playground/seeded-conversations", () => {
  test("forwards the prefix to the deps helper and returns the rows verbatim", async () => {
    const rows = [
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
    const { deps, listCalls } = makeStub({ listRows: rows });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(routes, "GET", "playground/seeded-conversations");

    const res = await route.handler(ctx());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      conversations: typeof rows;
    };
    expect(body.conversations).toEqual(rows);
    expect(listCalls).toEqual([PLAYGROUND_TITLE_PREFIX]);
  });
});

describe("DELETE playground/seeded-conversations/:id", () => {
  test("returns 403 when the conversation is not in the prefix-filtered set", async () => {
    // The list call (authoritative prefix check) returns nothing for this id.
    const { deps, deleteCalls } = makeStub({
      listRows: [
        {
          id: "other-playground-id",
          title: `${PLAYGROUND_TITLE_PREFIX}Kept`,
          messageCount: 1,
          createdAt: 1,
        },
      ],
    });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(
      routes,
      "DELETE",
      "playground/seeded-conversations/:id",
    );

    const res = await route.handler(ctx({ id: "non-playground-conv" }));

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Not a playground conversation");
    expect(deleteCalls).toEqual([]);
  });

  test("returns 200 and deletes when the id is a prefix-matching conversation", async () => {
    const { deps, deleteCalls } = makeStub({
      listRows: [
        {
          id: "conv-seeded",
          title: `${PLAYGROUND_TITLE_PREFIX}Seeded`,
          messageCount: 3,
          createdAt: 5,
        },
      ],
    });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(
      routes,
      "DELETE",
      "playground/seeded-conversations/:id",
    );

    const res = await route.handler(ctx({ id: "conv-seeded" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedCount: number };
    expect(body.deletedCount).toBe(1);
    expect(deleteCalls).toEqual(["conv-seeded"]);
  });

  test("returns deletedCount: 0 when deleteConversationById reports a miss", async () => {
    const { deps, deleteCalls } = makeStub({
      listRows: [
        {
          id: "conv-seeded",
          title: `${PLAYGROUND_TITLE_PREFIX}Seeded`,
          messageCount: 0,
          createdAt: 5,
        },
      ],
      deleteReturn: false,
    });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(
      routes,
      "DELETE",
      "playground/seeded-conversations/:id",
    );

    const res = await route.handler(ctx({ id: "conv-seeded" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedCount: number };
    expect(body.deletedCount).toBe(0);
    expect(deleteCalls).toEqual(["conv-seeded"]);
  });
});

describe("DELETE playground/seeded-conversations (bulk)", () => {
  test("enumerates only prefix-matching rows and calls delete for each", async () => {
    const rows = [
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
    const { deps, listCalls, deleteCalls } = makeStub({ listRows: rows });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(
      routes,
      "DELETE",
      "playground/seeded-conversations",
    );

    const res = await route.handler(ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedCount: number };
    expect(body.deletedCount).toBe(3);
    expect(listCalls).toEqual([PLAYGROUND_TITLE_PREFIX]);
    expect(deleteCalls).toEqual(["conv-a", "conv-b", "conv-c"]);
  });

  test("deletedCount reflects only rows where the underlying delete succeeded", async () => {
    const rows = [
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
    const { deps, deleteCalls } = makeStub({
      listRows: rows,
      deleteReturn: (id) => id !== "conv-missing",
    });
    const routes = seededConversationsRouteDefinitions(deps);
    const route = findRoute(
      routes,
      "DELETE",
      "playground/seeded-conversations",
    );

    const res = await route.handler(ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedCount: number };
    expect(body.deletedCount).toBe(1);
    expect(deleteCalls).toEqual(["conv-ok", "conv-missing"]);
  });
});

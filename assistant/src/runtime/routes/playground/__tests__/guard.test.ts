import { describe, expect, test } from "bun:test";

import type { Conversation } from "../../../../daemon/conversation.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import { assertPlaygroundEnabled } from "../guard.js";
import { playgroundRouteDefinitions } from "../index.js";

function makeDeps(enabled: boolean): PlaygroundRouteDeps {
  return {
    getConversationById: (_id: string): Conversation | undefined => undefined,
    isPlaygroundEnabled: () => enabled,
    listConversationsByTitlePrefix: () => [],
    deleteConversationById: () => false,
    createConversation: async (_title: string) => ({ id: "conv-test" }),
    addMessage: async (
      _conversationId: string,
      _role: "user" | "assistant",
      _contentJson: string,
    ) => ({ id: "msg-test" }),
  };
}

describe("assertPlaygroundEnabled", () => {
  test("returns a 404 Response when the flag is disabled", async () => {
    const result = assertPlaygroundEnabled(makeDeps(false));

    expect(result).toBeInstanceOf(Response);
    expect(result?.status).toBe(404);

    const body = (await result?.json()) as {
      error: { code: string; message: string };
    };
    // The body code must be `playground_disabled` (not the generic
    // `NOT_FOUND`) so the Swift `CompactionPlaygroundClient` can route
    // this to `.notAvailable` rather than `.notFound`. The two cases
    // collide on conv-scoped routes because this guard runs *before*
    // the conversation lookup — the URL alone cannot tell them apart.
    expect(body.error.code).toBe("playground_disabled");
    expect(body.error.message).toBe("Compaction playground is not enabled");
  });

  test("returns null when the flag is enabled", () => {
    expect(assertPlaygroundEnabled(makeDeps(true))).toBeNull();
  });
});

describe("playgroundRouteDefinitions", () => {
  test("returns route definitions regardless of flag state (guard runs per-request)", () => {
    // The flag check happens inside each route's handler via
    // `assertPlaygroundEnabled`, not at registration time. The aggregator
    // always returns every registered route; each handler returns 404 when
    // the flag is disabled.
    expect(playgroundRouteDefinitions(makeDeps(true)).length).toBeGreaterThan(
      0,
    );
    expect(playgroundRouteDefinitions(makeDeps(false)).length).toBeGreaterThan(
      0,
    );
  });

  test("registers the inject-failures playground route", () => {
    const routes = playgroundRouteDefinitions(makeDeps(true));
    expect(
      routes.some(
        (r) =>
          r.endpoint ===
            "conversations/:id/playground/inject-compaction-failures" &&
          r.method === "POST",
      ),
    ).toBe(true);
  });

  test("registers the seed-conversation endpoint", () => {
    const routes = playgroundRouteDefinitions(makeDeps(true));
    const endpoints = routes.map((r) => `${r.method} ${r.endpoint}`);
    expect(endpoints).toContain("POST playground/seed-conversation");
  });
});

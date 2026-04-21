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
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Not found");
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
});

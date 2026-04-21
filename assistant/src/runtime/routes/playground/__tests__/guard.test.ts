import { describe, expect, test } from "bun:test";

import type { Conversation } from "../../../../daemon/conversation.js";
import type { PlaygroundRouteDeps } from "../deps.js";
import { assertPlaygroundEnabled } from "../guard.js";
import { playgroundRouteDefinitions } from "../index.js";

function makeDeps(enabled: boolean): PlaygroundRouteDeps {
  return {
    getConversationById: (_id: string): Conversation | undefined => undefined,
    isPlaygroundEnabled: () => enabled,
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
  test("returns the registered playground routes regardless of flag state", () => {
    // Route list composition does not depend on the feature flag — per-route
    // `assertPlaygroundEnabled()` gating runs inside each handler at request
    // time. Compose-time independence keeps the router identical across
    // process lifetimes even if the flag is toggled at runtime.
    const enabled = playgroundRouteDefinitions(makeDeps(true));
    const disabled = playgroundRouteDefinitions(makeDeps(false));
    expect(enabled.length).toBeGreaterThan(0);
    expect(disabled.length).toBe(enabled.length);
  });
});

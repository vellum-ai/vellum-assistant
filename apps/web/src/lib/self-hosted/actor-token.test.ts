import { describe, expect, test } from "bun:test";

import { getSelfHostedActorToken } from "@/lib/self-hosted/actor-token.js";

describe("getSelfHostedActorToken", () => {
  // Pinning the stub return value so the day we wire up the real pairing
  // flow we're forced to update the test alongside it — a silent flip
  // from `null` to a real token would skip the deliberate landing-on-401
  // behavior that the chat-page self-hosted error screen depends on.
  test("returns null until the web pair flow is wired up", async () => {
    expect(await getSelfHostedActorToken("any-assistant-id")).toBeNull();
  });
});

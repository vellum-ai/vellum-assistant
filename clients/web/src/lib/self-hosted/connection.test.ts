import { afterEach, describe, expect, test } from "bun:test";

import {
  getSelfHostedAssistantId,
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";

describe("self-hosted connection slot", () => {
  afterEach(() => {
    setSelfHostedConnection(null);
  });

  test("starts with both slots null", () => {
    expect(getSelfHostedAssistantId()).toBeNull();
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBeNull();
  });

  test("round-trips url + token through the single setter", () => {
    setSelfHostedConnection({
      assistantId: "assistant-123",
      url: "https://example.ngrok-free.app",
      token: "token-xyz",
    });
    expect(getSelfHostedIngressUrl()).toBe("https://example.ngrok-free.app");
    expect(getSelfHostedActorToken()).toBe("token-xyz");
    expect(getSelfHostedAssistantId()).toBe("assistant-123");
  });

  test("setting null clears both slots", () => {
    setSelfHostedConnection({
      url: "https://example.ngrok-free.app",
      token: "token-xyz",
    });
    setSelfHostedConnection(null);
    expect(getSelfHostedAssistantId()).toBeNull();
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBeNull();
  });

  test("either slot can be null independently while the other is set", () => {
    // Brief window after `is_local=true` flips but before the gateway
    // registers a public hostname — url stays null, token may already
    // be present.
    setSelfHostedConnection({ url: null, token: "token-only" });
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBe("token-only");

    // Brief window after hatch but before bootstrap_platform_actor_token
    // lands a value — ingress known, token still null.
    setSelfHostedConnection({
      url: "https://example.ngrok-free.app",
      token: null,
    });
    expect(getSelfHostedIngressUrl()).toBe("https://example.ngrok-free.app");
    expect(getSelfHostedActorToken()).toBeNull();
  });
});

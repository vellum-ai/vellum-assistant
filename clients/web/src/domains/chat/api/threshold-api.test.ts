import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/gateway/client.gen";
import { getConversationOverride } from "@/lib/threshold-api";

// ---------------------------------------------------------------------------
// getConversationOverride — gateway-compat for the "no override" signal
// ---------------------------------------------------------------------------
//
// The gateway used to express "no per-conversation override exists" with a
// 404 response. That worked, but it surfaced a misleading network error in
// the browser console for what is the common case (most conversations have
// no override) and made the UI look broken even when everything was fine.
//
// The gateway now returns 200 with `{ threshold: null }` for the same
// condition. These tests pin the client to handle both shapes so a rolling
// deploy (older pods → newer pods) never breaks the override read path.
// ---------------------------------------------------------------------------

describe("getConversationOverride", () => {
  const originalGet = client.get;

  afterEach(() => {
    client.get = originalGet;
  });

  test("returns null when the gateway responds 200 with threshold:null", async () => {
    client.get = mock(async () => ({
      data: { threshold: null },
      error: null,
      response: new Response(JSON.stringify({ threshold: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    })) as typeof client.get;

    const result = await getConversationOverride("assistant-1", "conv-1");
    expect(result).toBeNull();
  });

  test("returns the threshold string when one exists", async () => {
    client.get = mock(async () => ({
      data: { threshold: "medium" },
      error: null,
      response: new Response(JSON.stringify({ threshold: "medium" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    })) as typeof client.get;

    const result = await getConversationOverride("assistant-1", "conv-1");
    expect(result).toBe("medium");
  });

  test("returns null when a legacy gateway responds with 404 (backward compat)", async () => {
    // Older gateways treat "no override" as a missing resource. The client
    // must keep silently coercing that to null so the UI stays quiet during
    // a rolling deploy where some pods serve the old contract.
    client.get = mock(async () => ({
      data: undefined,
      error: { error: "No override for this conversation" },
      response: new Response(
        JSON.stringify({ error: "No override for this conversation" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    })) as typeof client.get;

    const result = await getConversationOverride("assistant-1", "conv-1");
    expect(result).toBeNull();
  });

  test("throws ApiError for non-404 failures", async () => {
    client.get = mock(async () => ({
      data: undefined,
      error: { error: "Internal server error" },
      response: new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    })) as typeof client.get;

    await expect(
      getConversationOverride("assistant-1", "conv-1"),
    ).rejects.toThrow();
  });
});

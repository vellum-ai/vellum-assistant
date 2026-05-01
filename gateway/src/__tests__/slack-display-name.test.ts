import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const {
  normalizeSlackAppMention,
  resolveSlackUser,
  clearUserInfoCache,
  getUserInfoCacheSize,
} = await import("../slack/normalize.js");
import type { SlackAppMentionEvent } from "../slack/normalize.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: "default-assistant",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "default",
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
}

function makeEvent(
  overrides: Partial<SlackAppMentionEvent> = {},
): SlackAppMentionEvent {
  return {
    type: "app_mention",
    user: "U_USER123",
    text: "<@U123BOT> hello world",
    ts: "1700000000.000100",
    channel: "C_CHANNEL1",
    ...overrides,
  };
}

beforeEach(() => {
  clearUserInfoCache();
});

describe("resolveSlackUser", () => {
  test("resolves display_name and username from users.info", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            name: "jdoe",
            real_name: "Jane Doe",
            profile: { display_name: "Jane D", real_name: "Jane Doe" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const info = await resolveSlackUser("U123", "xoxb-token");
    expect(info).not.toBeUndefined();
    expect(info!.displayName).toBe("Jane D");
    expect(info!.username).toBe("jdoe");
  });

  test("falls back to real_name when display_name is empty", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            name: "jdoe",
            real_name: "Jane Doe",
            profile: { display_name: "", real_name: "Jane Doe" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const info = await resolveSlackUser("U123", "xoxb-token");
    expect(info!.displayName).toBe("Jane Doe");
  });

  test("returns undefined on API failure", async () => {
    fetchMock = mock(async () => {
      return new Response("", { status: 500 });
    });

    const info = await resolveSlackUser("U123", "xoxb-token");
    expect(info).toBeUndefined();
  });

  test("returns undefined when user not found", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "user_not_found" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const info = await resolveSlackUser("U_INVALID", "xoxb-token");
    expect(info).toBeUndefined();
  });

  test("caches results to avoid repeated API calls", async () => {
    let callCount = 0;
    fetchMock = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          ok: true,
          user: { name: "jdoe", profile: { display_name: "Jane" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await resolveSlackUser("U_CACHED", "xoxb-token");
    await resolveSlackUser("U_CACHED", "xoxb-token");
    await resolveSlackUser("U_CACHED", "xoxb-token");

    expect(callCount).toBe(1);
    expect(getUserInfoCacheSize()).toBe(1);
  });
});

describe("normalizeSlackAppMention with display name", () => {
  test("omits displayName on first call (cache miss), populates on second after cache warm", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            name: "testuser",
            real_name: "Test User",
            profile: { display_name: "Test U" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const config = makeConfig();
    const event = makeEvent({ user: "U_WITH_NAME" });

    // First call: cache miss, fires background fetch, no display name yet
    const result1 = normalizeSlackAppMention(
      event,
      "evt-dn-1a",
      config,
      undefined,
      "xoxb-test",
    );
    expect(result1).not.toBeNull();
    expect(result1!.event.actor.displayName).toBeUndefined();

    // Wait for background fetch to complete and populate cache
    await new Promise((r) => setTimeout(r, 50));

    // Second call: cache hit, display name populated
    const result2 = normalizeSlackAppMention(
      event,
      "evt-dn-1b",
      config,
      undefined,
      "xoxb-test",
    );
    expect(result2).not.toBeNull();
    expect(result2!.event.actor.displayName).toBe("Test U");
    expect(result2!.event.actor.username).toBe("testuser");
  });

  test("populates displayName immediately when cache is pre-warmed", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            name: "testuser",
            real_name: "Test User",
            profile: { display_name: "Test U" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const config = makeConfig();
    const event = makeEvent({ user: "U_PREWARM" });

    // Pre-warm the cache with an explicit async call
    await resolveSlackUser("U_PREWARM", "xoxb-test");

    const result = normalizeSlackAppMention(
      event,
      "evt-dn-pw",
      config,
      undefined,
      "xoxb-test",
    );
    expect(result).not.toBeNull();
    expect(result!.event.actor.displayName).toBe("Test U");
    expect(result!.event.actor.username).toBe("testuser");
  });

  test("renders cache-warmed mention labels in model-facing content", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            name: "leo",
            real_name: "Leo Example",
            profile: { display_name: "Leo" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const config = makeConfig();
    const event = makeEvent({
      text: "<@U123BOT> <@ULEO> please look",
    });
    const userInfo = await resolveSlackUser("ULEO", "xoxb-test");

    const result = normalizeSlackAppMention(
      event,
      "evt-mention-cache",
      config,
      "U123BOT",
      undefined,
      { userLabels: userInfo ? { ULEO: userInfo.displayName } : {} },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@Leo please look");
    expect(result!.event.message.content).not.toContain("<@ULEO>");
    expect(result!.event.message.content).not.toContain("ULEO");
  });

  test("renders unresolved mention IDs with fallback labels when lookup fails", async () => {
    fetchMock = mock(async () => {
      return new Response("", { status: 500 });
    });

    const config = makeConfig();
    const event = makeEvent({
      text: "<@U123BOT> <@UFAIL> please look",
    });
    const userInfo = await resolveSlackUser("UFAIL", "xoxb-test");

    const result = normalizeSlackAppMention(
      event,
      "evt-mention-fallback",
      config,
      "U123BOT",
      undefined,
      { userLabels: userInfo ? { UFAIL: userInfo.displayName } : {} },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@unknown-user please look");
    expect(result!.event.message.content).not.toContain("<@UFAIL>");
    expect(result!.event.message.content).not.toContain("UFAIL");
  });

  test("omits displayName when bot token is not configured", () => {
    const config = makeConfig();
    const event = makeEvent();
    const result = normalizeSlackAppMention(event, "evt-dn-2", config);

    expect(result).not.toBeNull();
    expect(result!.event.actor.displayName).toBeUndefined();
    expect(result!.event.actor.username).toBeUndefined();
  });

  test("omits displayName when user resolution fails", async () => {
    fetchMock = mock(async () => {
      return new Response("", { status: 500 });
    });

    const config = makeConfig();
    const event = makeEvent();
    const result = normalizeSlackAppMention(
      event,
      "evt-dn-3",
      config,
      undefined,
      "xoxb-test",
    );

    expect(result).not.toBeNull();
    expect(result!.event.actor.displayName).toBeUndefined();
    expect(result!.event.actor.actorExternalId).toBe("U_USER123");
  });
});

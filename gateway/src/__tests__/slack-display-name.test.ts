import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type {
  RuntimeInboundPayload,
  RuntimeInboundResponse,
} from "../runtime/client.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);
let runtimePayloads: RuntimeInboundPayload[] = [];
const forwardToRuntimeMock = mock(
  async (
    _config: GatewayConfig,
    payload: RuntimeInboundPayload,
  ): Promise<RuntimeInboundResponse> => {
    runtimePayloads.push(payload);
    return { accepted: true, duplicate: false, eventId: "runtime-event-1" };
  },
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

mock.module("../runtime/client.js", () => ({
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    readonly retryAfterSecs: number;

    constructor(retryAfterSecs: number) {
      super("Circuit breaker is open");
      this.retryAfterSecs = retryAfterSecs;
    }
  },
  forwardToRuntime: (...args: Parameters<typeof forwardToRuntimeMock>) =>
    forwardToRuntimeMock(...args),
}));

const {
  normalizeSlackAppMention,
  resolveSlackChannel,
  resolveSlackUser,
  resolveSlackUserSync,
  clearChannelInfoCache,
  clearInFlightFetches,
  clearUserInfoCache,
  getChannelInfoCacheSize,
  getUserInfoCacheSize,
} = await import("../slack/normalize.js");
const { handleInbound } = await import("../handlers/handle-inbound.js");
const { initGatewayDb, resetGatewayDb } = await import("../db/connection.js");
const { initAdmissionPolicyCache, resetAdmissionPolicyCache } =
  await import("../risk/admission-policy-cache.js");
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

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  initAdmissionPolicyCache();
  clearUserInfoCache();
  clearChannelInfoCache();
  clearInFlightFetches();
  runtimePayloads = [];
  forwardToRuntimeMock.mockClear();
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
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
            tz: "America/New_York",
            tz_label: "Eastern Daylight Time",
            tz_offset: -14400,
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
    expect(info!.timezone).toBe("America/New_York");
    expect(info!.timezoneLabel).toBe("Eastern Daylight Time");
    expect(info!.timezoneOffsetSeconds).toBe(-14400);
    // A successful users.info is a positive resolution: explicit false, not
    // absent, so downstream trust policy can distinguish "member" from
    // "unknown".
    expect(info!.isBot).toBe(false);
    expect(info!.isStranger).toBe(false);
    expect(info!.isRestricted).toBe(false);
  });

  test("resolves the is_bot signal for bot users", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            name: "shard-bot",
            real_name: "Shard",
            is_bot: true,
            profile: { display_name: "Shard" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const info = await resolveSlackUser("U-BOT", "xoxb-token");
    expect(info).not.toBeUndefined();
    expect(info!.isBot).toBe(true);
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

  test("scopes cached user info by bot token", async () => {
    let callCount = 0;
    fetchMock = mock(async (_input, init) => {
      callCount++;
      const auth = new Headers(init?.headers).get("authorization");
      const user =
        auth === "Bearer xoxb-team-a"
          ? {
              name: "alice",
              tz: "America/New_York",
              tz_label: "Eastern Daylight Time",
              tz_offset: -14400,
              profile: { display_name: "Alice" },
            }
          : {
              name: "bob",
              tz: "America/Los_Angeles",
              tz_label: "Pacific Daylight Time",
              tz_offset: -25200,
              profile: { display_name: "Bob" },
            };
      return new Response(JSON.stringify({ ok: true, user }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const [teamAInfo, teamBInfo] = await Promise.all([
      resolveSlackUser("U_SHARED", "xoxb-team-a"),
      resolveSlackUser("U_SHARED", "xoxb-team-b"),
    ]);

    expect(teamAInfo!.displayName).toBe("Alice");
    expect(teamAInfo!.timezone).toBe("America/New_York");
    expect(teamBInfo!.displayName).toBe("Bob");
    expect(teamBInfo!.timezone).toBe("America/Los_Angeles");
    expect(callCount).toBe(2);
    expect(getUserInfoCacheSize()).toBe(2);

    await resolveSlackUser("U_SHARED", "xoxb-team-a");
    await resolveSlackUser("U_SHARED", "xoxb-team-b");
    expect(callCount).toBe(2);
  });

  test("sync cache lookup uses the bot token scope", async () => {
    let callCount = 0;
    fetchMock = mock(async (_input, init) => {
      callCount++;
      const auth = new Headers(init?.headers).get("authorization");
      const user =
        auth === "Bearer xoxb-team-a"
          ? {
              name: "alice",
              tz: "America/Denver",
              tz_label: "Mountain Daylight Time",
              tz_offset: -21600,
              profile: { display_name: "Alice" },
            }
          : {
              name: "bob",
              tz: "Europe/London",
              tz_label: "British Summer Time",
              tz_offset: 3600,
              profile: { display_name: "Bob" },
            };
      return new Response(JSON.stringify({ ok: true, user }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await resolveSlackUser("U_SHARED_SYNC", "xoxb-team-a");

    const teamACached = resolveSlackUserSync("U_SHARED_SYNC", "xoxb-team-a");
    expect(teamACached!.displayName).toBe("Alice");
    expect(teamACached!.timezone).toBe("America/Denver");

    const teamBMiss = resolveSlackUserSync("U_SHARED_SYNC", "xoxb-team-b");
    expect(teamBMiss).toBeUndefined();

    const teamBResolved = await resolveSlackUser(
      "U_SHARED_SYNC",
      "xoxb-team-b",
    );
    expect(teamBResolved!.displayName).toBe("Bob");
    expect(teamBResolved!.timezone).toBe("Europe/London");

    const teamBCached = resolveSlackUserSync("U_SHARED_SYNC", "xoxb-team-b");
    expect(teamBCached!.displayName).toBe("Bob");
    expect(teamBCached!.timezone).toBe("Europe/London");
    expect(callCount).toBe(2);
    expect(getUserInfoCacheSize()).toBe(2);
  });
});

describe("resolveSlackChannel", () => {
  test("resolves channel name from conversations.info", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          channel: { id: "C123", name: "user-feedback" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const info = await resolveSlackChannel("C123", "xoxb-token");
    expect(info).not.toBeUndefined();
    expect(info!.name).toBe("user-feedback");
  });

  test("uses name_normalized when name is absent", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          channel: { id: "C123", name_normalized: "normalized-channel" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const info = await resolveSlackChannel("C123", "xoxb-token");
    expect(info!.name).toBe("normalized-channel");
  });

  test("returns undefined on API failure", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "channel_not_found" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const info = await resolveSlackChannel("C_UNKNOWN", "xoxb-token");
    expect(info).toBeUndefined();
  });

  test("caches channel names to avoid repeated API calls", async () => {
    let callCount = 0;
    fetchMock = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          ok: true,
          channel: { id: "C_CACHED", name: "cached-channel" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await resolveSlackChannel("C_CACHED", "xoxb-token");
    await resolveSlackChannel("C_CACHED", "xoxb-token");
    await resolveSlackChannel("C_CACHED", "xoxb-token");

    expect(callCount).toBe(1);
    expect(getChannelInfoCacheSize()).toBe(1);
  });

  test("scopes cached channel names by bot token", async () => {
    let callCount = 0;
    fetchMock = mock(async (_input, init) => {
      callCount++;
      const auth = new Headers(init?.headers).get("authorization");
      const channel =
        auth === "Bearer xoxb-team-a"
          ? { id: "C_SHARED", name: "team-a-channel" }
          : { id: "C_SHARED", name: "team-b-channel" };
      return new Response(JSON.stringify({ ok: true, channel }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const [teamAInfo, teamBInfo] = await Promise.all([
      resolveSlackChannel("C_SHARED", "xoxb-team-a"),
      resolveSlackChannel("C_SHARED", "xoxb-team-b"),
    ]);

    expect(teamAInfo!.name).toBe("team-a-channel");
    expect(teamBInfo!.name).toBe("team-b-channel");
    expect(callCount).toBe(2);
    expect(getChannelInfoCacheSize()).toBe(2);

    await resolveSlackChannel("C_SHARED", "xoxb-team-a");
    await resolveSlackChannel("C_SHARED", "xoxb-team-b");
    expect(callCount).toBe(2);
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
            tz: "America/Denver",
            tz_label: "Mountain Daylight Time",
            tz_offset: -21600,
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
      "xoxb-test",
    );
    expect(result).not.toBeNull();
    expect(result!.event.actor.displayName).toBe("Test U");
    expect(result!.event.actor.username).toBe("testuser");
    expect(result!.event.actor.timezone).toBe("America/Denver");
    expect(result!.event.actor.timezoneLabel).toBe("Mountain Daylight Time");
    expect(result!.event.actor.timezoneOffsetSeconds).toBe(-21600);
  });

  test("forwards cached Slack timezone fields in runtime source metadata", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            name: "testuser",
            real_name: "Test User",
            tz: "America/Los_Angeles",
            tz_label: "Pacific Daylight Time",
            tz_offset: -25200,
            profile: { display_name: "Test U" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const config = makeConfig();
    const event = makeEvent({ user: "U_WITH_TZ" });
    await resolveSlackUser("U_WITH_TZ", "xoxb-test");

    const result = normalizeSlackAppMention(
      event,
      "evt-tz-forward",
      config,
      "xoxb-test",
    );
    expect(result).not.toBeNull();

    await handleInbound(config, result!.event, {
      routingOverride: result!.routing,
    });

    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    const forwardedPayload = runtimePayloads[0];
    expect(forwardedPayload).toBeDefined();
    expect(forwardedPayload!.sourceMetadata!.timezone).toBe(
      "America/Los_Angeles",
    );
    expect(forwardedPayload!.sourceMetadata!.timezoneLabel).toBe(
      "Pacific Daylight Time",
    );
    expect(forwardedPayload!.sourceMetadata!.timezoneOffsetSeconds).toBe(
      -25200,
    );
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
      undefined,
      { userLabels: userInfo ? { ULEO: userInfo.displayName } : {} },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe(
      "@unknown-user @Leo please look",
    );
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
      undefined,
      { userLabels: userInfo ? { UFAIL: userInfo.displayName } : {} },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe(
      "@unknown-user @unknown-user please look",
    );
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
      "xoxb-test",
    );

    expect(result).not.toBeNull();
    expect(result!.event.actor.displayName).toBeUndefined();
    expect(result!.event.actor.actorExternalId).toBe("U_USER123");
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import { setConfig } from "./helpers/set-config.js";

let mockSecureKeys: Record<string, string>;

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockSecureKeys[key] ?? null,
  setSecureKeyAsync: async (key: string, value: string) => {
    mockSecureKeys[key] = value;
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    delete mockSecureKeys[key];
    return true;
  },
}));

mock.module("../calls/twilio-rest.js", () => ({
  hasTwilioCredentials: () => false,
}));

mock.module("../calls/twilio-config.js", () => ({
  resolveTwilioPhoneNumber: () => undefined,
}));

mock.module("./channel-invite-transports/whatsapp.js", () => ({
  resolveWhatsAppDisplayNumber: () => undefined,
}));

type SocketHealth = {
  channel: string;
  status: "connected" | "disconnected" | "not_configured" | "unsupported";
  lastLivenessAt?: number;
};
let socketHealth: SocketHealth | Error;

mock.module("../channels/gateway-channel-socket-health.js", () => ({
  readChannelSocketHealth: async () => {
    if (socketHealth instanceof Error) {
      throw socketHealth;
    }
    return socketHealth;
  },
}));

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let fetchHandler: (
  url: string,
  init?: RequestInit,
) => { ok: boolean; body: unknown; scopes?: string };

beforeEach(() => {
  mockSecureKeys = {};
  // Reset the seeded slack section to its empty (all-defaults) state.
  setConfig("slack", {});
  fetchCalls = [];
  fetchHandler = () => ({ ok: true, body: { ok: true } });
  socketHealth = { channel: "slack", status: "connected" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    const { ok, body, scopes } = fetchHandler(url, init);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    // Slack stamps the granted scopes on every Web API response.
    if (scopes !== undefined) {
      headers["x-oauth-scopes"] = scopes;
    }
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers,
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function runSlackRemoteProbe() {
  const { createReadinessService } =
    await import("../runtime/channel-readiness-service.js");
  const service = createReadinessService();
  return service.getReadiness("slack", true);
}

describe("slack remote probe (auth.test)", () => {
  test("reports skipped when no bot_token is stored", async () => {
    const [snapshot] = await runSlackRemoteProbe();
    const remote = snapshot.remoteChecks ?? [];
    expect(remote.length).toBeGreaterThan(0);
    expect(remote[0].name).toBe("auth_test");
    expect(remote[0].passed).toBe(false);
    expect(remote[0].message).toMatch(/no bot_token/i);
    // fetch must not be called when there is no token
    expect(fetchCalls.length).toBe(0);
  });

  test("passes when Slack auth.test returns ok and workspaces match", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    setConfig("slack", { teamId: "T123" });
    fetchHandler = () => ({
      ok: true,
      body: { ok: true, team_id: "T123", team: "acme", user: "apollobot" },
    });

    const [snapshot] = await runSlackRemoteProbe();
    const remote = snapshot.remoteChecks ?? [];
    const authTest = remote.find((c) => c.name === "auth_test")!;
    const wsMatch = remote.find((c) => c.name === "workspace_match")!;

    expect(authTest.passed).toBe(true);
    expect(authTest.message).toContain("acme");
    expect(wsMatch.passed).toBe(true);

    // The first slack fetch should hit auth.test
    expect(fetchCalls[0].url).toBe("https://slack.com/api/auth.test");
    expect(
      (fetchCalls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer xoxb-fake");
  });

  test("fails when Slack auth.test rejects the bot_token", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-stale";
    fetchHandler = () => ({
      ok: true,
      body: { ok: false, error: "invalid_auth" },
    });

    const [snapshot] = await runSlackRemoteProbe();
    const authTest = snapshot.remoteChecks!.find(
      (c) => c.name === "auth_test",
    )!;
    expect(authTest.passed).toBe(false);
    expect(authTest.message).toMatch(/invalid_auth/);
  });

  test("flags workspace mismatch between stored config and live token", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    setConfig("slack", { teamId: "T_old" });
    fetchHandler = () => ({
      ok: true,
      body: { ok: true, team_id: "T_new", team: "newco", user: "apollobot" },
    });

    const [snapshot] = await runSlackRemoteProbe();
    const wsMatch = snapshot.remoteChecks!.find(
      (c) => c.name === "workspace_match",
    )!;
    expect(wsMatch.passed).toBe(false);
    expect(wsMatch.message).toContain("T_old");
    expect(wsMatch.message).toContain("T_new");
    expect(wsMatch.message).toContain("reconnect");
  });

  test("reports network failure as a failed check", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const [snapshot] = await runSlackRemoteProbe();
    const authTest = snapshot.remoteChecks!.find(
      (c) => c.name === "auth_test",
    )!;
    expect(authTest.passed).toBe(false);
    expect(authTest.message).toMatch(/ECONNREFUSED/);
  });
});

/**
 * Slack can install an app with a fraction of the manifest's scopes while
 * auth.test still succeeds, leaving the first real API call to fail with
 * missing_scope. auth.test passing is therefore not evidence the install is
 * usable.
 */
describe("slack auth.test response validation", () => {
  test("reports an unexpected shape instead of trusting the field types", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    // `ok` as a string slips past a cast and makes `!data.ok` decide on a
    // truthy string rather than a boolean.
    fetchHandler = () => ({ ok: true, body: { ok: "yes" } });

    const [snapshot] = await runSlackRemoteProbe();
    const authTest = snapshot.remoteChecks!.find(
      (c) => c.name === "auth_test",
    )!;

    expect(authTest.passed).toBe(false);
    expect(authTest.message).toMatch(/unexpected response shape/i);
  });

  test("tolerates unknown fields Slack adds over time", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    fetchHandler = () => ({
      ok: true,
      body: { ok: true, team: "acme", user: "bot", some_new_field: 42 },
    });

    const [snapshot] = await runSlackRemoteProbe();
    const authTest = snapshot.remoteChecks!.find(
      (c) => c.name === "auth_test",
    )!;

    expect(authTest.passed).toBe(true);
  });
});

describe("slack scope-grant check", () => {
  const ALL_REQUIRED = [
    "app_mentions:read",
    "assistant:write",
    "channels:history",
    "channels:read",
    "chat:write",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "mpim:read",
    "users:read",
  ];

  function okWithScopes(scopes: string) {
    return () => ({
      ok: true,
      body: { ok: true, team_id: "T123", team: "acme", user: "apollobot" },
      scopes,
    });
  }

  test("passes when every required scope was granted", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    fetchHandler = okWithScopes(ALL_REQUIRED.join(","));

    const [snapshot] = await runSlackRemoteProbe();
    const scopeCheck = snapshot.remoteChecks!.find(
      (c) => c.name === "scopes_granted",
    )!;

    expect(scopeCheck.passed).toBe(true);
  });

  test("ignores declinable scopes the workspace opted out of", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    // No files:read / reactions:* / channels:join — all marked optional in the
    // manifest, so declining them is a choice, not a fault.
    fetchHandler = okWithScopes(ALL_REQUIRED.join(","));

    const [snapshot] = await runSlackRemoteProbe();
    const scopeCheck = snapshot.remoteChecks!.find(
      (c) => c.name === "scopes_granted",
    )!;

    expect(scopeCheck.passed).toBe(true);
  });

  test("catches the silent drop that auth.test reports as healthy", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    // The live symptom: token came back with a couple of scopes.
    fetchHandler = okWithScopes("channels:history,chat:write");

    const [snapshot] = await runSlackRemoteProbe();
    const authTest = snapshot.remoteChecks!.find(
      (c) => c.name === "auth_test",
    )!;
    const scopeCheck = snapshot.remoteChecks!.find(
      (c) => c.name === "scopes_granted",
    )!;

    // auth.test is happy — that is exactly why this check has to exist.
    expect(authTest.passed).toBe(true);
    expect(scopeCheck.passed).toBe(false);
    expect(scopeCheck.message).toContain("assistant:write");
    expect(scopeCheck.message).not.toContain("chat:write,");
    // Recovery order matters: the update prompt gates the reinstall.
    expect(scopeCheck.message).toMatch(/update prompt/i);
    expect(scopeCheck.message).toMatch(/Reinstall to Workspace/i);
  });

  test("stays passing when Slack sends no scope header", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    fetchHandler = () => ({
      ok: true,
      body: { ok: true, team_id: "T123", team: "acme", user: "apollobot" },
    });

    const [snapshot] = await runSlackRemoteProbe();
    const scopeCheck = snapshot.remoteChecks!.find(
      (c) => c.name === "scopes_granted",
    )!;

    expect(scopeCheck.passed).toBe(true);
    expect(scopeCheck.message).toMatch(/skipped/i);
  });

  test("tolerates whitespace in the comma-separated header", async () => {
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    fetchHandler = okWithScopes(` ${ALL_REQUIRED.join(" , ")} ,, `);

    const [snapshot] = await runSlackRemoteProbe();
    const scopeCheck = snapshot.remoteChecks!.find(
      (c) => c.name === "scopes_granted",
    )!;

    expect(scopeCheck.passed).toBe(true);
  });
});

describe("slack inbound delivery", () => {
  /**
   * Credential health and delivery health are different claims. Valid tokens,
   * a reachable `auth.test` and a matching workspace all hold while a socket
   * sits open and delivers nothing, so the delivery verdict must not ride on
   * any of them.
   */
  test("fails on a dead socket even while auth.test passes", async () => {
    // Both tokens, or the channel is not fully configured and "incomplete" is
    // the correct answer rather than the one under test.
    mockSecureKeys[credentialKey("slack_channel", "bot_token")] = "xoxb-fake";
    mockSecureKeys[credentialKey("slack_channel", "app_token")] = "xapp-fake";
    setConfig("slack", { teamId: "T123" });
    fetchHandler = () => ({
      ok: true,
      body: { ok: true, team_id: "T123", team: "acme", user: "apollobot" },
    });
    socketHealth = { channel: "slack", status: "disconnected" };

    const [snapshot] = await runSlackRemoteProbe();
    const authTest = (snapshot.remoteChecks ?? []).find(
      (c) => c.name === "auth_test",
    )!;
    const delivery = snapshot.localChecks.find(
      (c) => c.name === "inbound_delivery",
    )!;

    expect(authTest.passed).toBe(true);
    expect(delivery.passed).toBe(false);
    expect(delivery.indeterminate).toBeFalsy();
    expect(delivery.message).toMatch(/not reaching this assistant/i);
    // The point of declaring it operational: a configured channel whose
    // socket is dead is down, not half set up.
    expect(snapshot.setupStatus).toBe("ready");
    expect(snapshot.health).toBe("failing");
    expect(snapshot.ready).toBe(false);
  });

  test("passes on a live socket and reports the last keepalive", async () => {
    socketHealth = {
      channel: "slack",
      status: "connected",
      lastLivenessAt: Date.parse("2026-08-21T17:00:00.000Z"),
    };

    const [snapshot] = await runSlackRemoteProbe();
    const delivery = snapshot.localChecks.find(
      (c) => c.name === "inbound_delivery",
    )!;

    expect(delivery.passed).toBe(true);
    expect(delivery.message).toContain("2026-08-21T17:00:00.000Z");
  });

  test("a freshly opened socket passes before its first keepalive", async () => {
    // The first probe is a full interval after open, so requiring a keepalive
    // would report every healthy reconnect as broken.
    socketHealth = { channel: "slack", status: "connected" };

    const [snapshot] = await runSlackRemoteProbe();
    const delivery = snapshot.localChecks.find(
      (c) => c.name === "inbound_delivery",
    )!;

    expect(delivery.passed).toBe(true);
    expect(delivery.message).toMatch(/no keepalive answered yet/i);
  });

  test("an unconfigured channel is indeterminate, not broken", async () => {
    socketHealth = { channel: "slack", status: "not_configured" };

    const [snapshot] = await runSlackRemoteProbe();
    const delivery = snapshot.localChecks.find(
      (c) => c.name === "inbound_delivery",
    )!;

    expect(delivery.indeterminate).toBe(true);
    expect(delivery.passed).toBe(true);
  });

  test("an unreachable gateway is indeterminate, not an outage", async () => {
    // A gateway we cannot reach is a fact about the gateway. Rendering it as
    // "Slack is disconnected" would invent an outage.
    socketHealth = new Error("gateway socket refused");

    const [snapshot] = await runSlackRemoteProbe();
    const delivery = snapshot.localChecks.find(
      (c) => c.name === "inbound_delivery",
    )!;

    expect(delivery.indeterminate).toBe(true);
    expect(delivery.passed).toBe(true);
    expect(delivery.message).toMatch(/could not reach the gateway/i);
    // Unknown, not failing: an unreachable gateway is a fact about the
    // gateway, and the channel must be neither vouched for nor condemned.
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.ready).toBe(false);
  });

  test("runs on every request rather than riding the remote-check cache", async () => {
    // Remote checks are cached for five minutes, which is far longer than a
    // socket takes to die and recover, so a cached verdict would report a
    // state the connection has already left. One service instance across both
    // reads, or the cache under test is never populated in the first place.
    const { createReadinessService } =
      await import("../runtime/channel-readiness-service.js");
    const service = createReadinessService();
    const delivery = (
      snapshots: Awaited<ReturnType<typeof service.getReadiness>>,
    ) => snapshots[0].localChecks.find((c) => c.name === "inbound_delivery")!;

    socketHealth = { channel: "slack", status: "connected" };
    expect(delivery(await service.getReadiness("slack", true)).passed).toBe(
      true,
    );

    // Same service, so the remote checks beside this one are now cached.
    socketHealth = { channel: "slack", status: "disconnected" };
    expect(delivery(await service.getReadiness("slack", true)).passed).toBe(
      false,
    );
  });
});

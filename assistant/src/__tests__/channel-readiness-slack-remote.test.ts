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

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let fetchHandler: (
  url: string,
  init?: RequestInit,
) => { ok: boolean; body: unknown };

beforeEach(() => {
  mockSecureKeys = {};
  // Reset the seeded slack section to its empty (all-defaults) state.
  setConfig("slack", {});
  fetchCalls = [];
  fetchHandler = () => ({ ok: true, body: { ok: true } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    const { ok, body } = fetchHandler(url, init);
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
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

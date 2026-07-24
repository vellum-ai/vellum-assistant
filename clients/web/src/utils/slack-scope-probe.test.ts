import { describe, expect, it } from "bun:test";

import { probeSlackScopes, type FetchLike } from "./slack-scope-probe";
import { SLACK_MANIFEST_BOT_SCOPES } from "./slack-manifest";

const TOKEN = "xoxb-0000000000-0000000000-abcdefghij";

/** Build a mocked `auth.test` response. `scopes: null` omits the header. */
function mockAuthTest({
  ok = true,
  scopes,
  appId = "A0EXAMPLE",
}: {
  ok?: boolean;
  scopes: string[] | null;
  appId?: string | null;
}): FetchLike {
  const headers = new Headers();
  if (scopes !== null) {headers.set("x-oauth-scopes", scopes.join(","));}
  const body: Record<string, unknown> = { ok };
  if (appId !== null) {body.app_id = appId;}
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers })) as FetchLike;
}

describe("probeSlackScopes", () => {
  it("reports complete when every expected scope was granted", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: [...SLACK_MANIFEST_BOT_SCOPES] }),
    });

    expect(result.status).toBe("complete");
    expect(result.missingScopes).toEqual([]);
    expect(result.appId).toBe("A0EXAMPLE");
  });

  it("ignores extra scopes Slack grants beyond the manifest", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({
        scopes: [...SLACK_MANIFEST_BOT_SCOPES, "team:read"],
      }),
    });

    expect(result.status).toBe("complete");
  });

  it("reports the missing scopes on a silent drop", async () => {
    // The live-test symptom: the token came back with a couple of scopes.
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: ["chat:write", "im:history"] }),
    });

    expect(result.status).toBe("incomplete");
    expect(result.grantedScopes).toEqual(["chat:write", "im:history"]);
    expect(result.missingScopes).toContain("assistant:write");
    expect(result.missingScopes).not.toContain("chat:write");
    expect(result.missingScopes).toHaveLength(
      SLACK_MANIFEST_BOT_SCOPES.length - 2,
    );
    expect(result.missingRequiredScopes.length).toBeGreaterThan(0);
  });

  it("reports declined optional scopes as degraded, not incomplete", async () => {
    // Declining an optional scope is a choice made on Slack's consent screen.
    // Reinstalling replays that screen, so it must not trigger the nudge.
    const withoutOptional = SLACK_MANIFEST_BOT_SCOPES.filter(
      (s) => s !== "reactions:read" && s !== "files:read",
    );
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: [...withoutOptional] }),
    });

    expect(result.status).toBe("degraded");
    expect(result.missingScopes).toEqual(["files:read", "reactions:read"]);
    expect(result.missingRequiredScopes).toEqual([]);
  });

  it("still reports incomplete when a mandatory scope goes missing alongside optional ones", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: ["chat:write"] }),
    });

    expect(result.status).toBe("incomplete");
    expect(result.missingRequiredScopes).toContain("assistant:write");
    // Optional gaps are still reported, just not what drives the nudge.
    expect(result.missingScopes).toContain("files:read");
    expect(result.missingRequiredScopes).not.toContain("files:read");
  });

  it("deep-links to the app's OAuth page when app_id is present", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: ["chat:write"], appId: "A123XYZ" }),
    });

    expect(result.reinstallUrl).toBe("https://api.slack.com/apps/A123XYZ/oauth");
  });

  it("falls back to the apps list when app_id is absent", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: ["chat:write"], appId: null }),
    });

    expect(result.appId).toBeNull();
    expect(result.reinstallUrl).toBe("https://api.slack.com/apps");
  });

  it("stays unknown when the scope header is unreadable (CORS)", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: null }),
    });

    expect(result.status).toBe("unknown");
    expect(result.missingScopes).toEqual([]);
    expect(result.missingRequiredScopes).toEqual([]);
  });

  it("stays unknown when Slack rejects the token", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ ok: false, scopes: ["chat:write"] }),
    });

    expect(result.status).toBe("unknown");
  });

  it("stays unknown, and does not throw, on a network failure", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };

    const result = await probeSlackScopes(TOKEN, { fetchImpl: failing });

    expect(result.status).toBe("unknown");
  });

  it("stays unknown when the response body is not JSON", async () => {
    const notJson: FetchLike = async () =>
      new Response("<html>gateway error</html>", { status: 200 });

    const result = await probeSlackScopes(TOKEN, { fetchImpl: notJson });

    expect(result.status).toBe("unknown");
  });

  it("tolerates whitespace in the comma-separated scope header", async () => {
    const spaced: FetchLike = async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "x-oauth-scopes": " chat:write , im:history ,, " },
      });

    const result = await probeSlackScopes(TOKEN, { fetchImpl: spaced });

    expect(result.grantedScopes).toEqual(["chat:write", "im:history"]);
  });

  it("honors a caller-supplied expected-scope list", async () => {
    const result = await probeSlackScopes(TOKEN, {
      fetchImpl: mockAuthTest({ scopes: ["chat:write"] }),
      expectedScopes: ["chat:write"],
      optionalScopes: [],
    });

    expect(result.status).toBe("complete");
  });
});

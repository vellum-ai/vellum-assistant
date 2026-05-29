import { describe, expect, mock, test } from "bun:test";

let mockAccessToken: string | null = null;

mock.module("../codex-token-refresh.js", () => ({
  getValidCodexAccessToken: async () => mockAccessToken,
}));

import { resolveAuth } from "../resolve-auth.js";

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("resolveAuth oauth_subscription", () => {
  test("adds ChatGPT account id header when present in the access token", async () => {
    mockAccessToken = fakeJwt({ chatgpt_account_id: "account-123" });

    const result = await resolveAuth(
      {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      },
      "openai",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toEqual({
        kind: "header",
        headers: {
          Authorization: `Bearer ${mockAccessToken}`,
          "ChatGPT-Account-ID": "account-123",
        },
      });
    }
  });
});

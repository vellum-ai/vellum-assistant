import { describe, test, expect, beforeAll } from "bun:test";
import "./test-preload.js";

import {
  initSigningKey,
  loadOrCreateSigningKey,
  verifyToken,
} from "../auth/token-service.js";
import { createCloudOAuthTokenHandler } from "../http/routes/cloud-oauth-token.js";

beforeAll(() => {
  initSigningKey(loadOrCreateSigningKey());
});

const handler = createCloudOAuthTokenHandler();

/** Build a POST request to the cloud OAuth token endpoint. */
function makeRequest(body: unknown): Request {
  return new Request(
    "http://gateway.test/v1/internal/oauth/chrome-extension/token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

describe("POST /v1/internal/oauth/chrome-extension/token", () => {
  test("happy path: valid body returns 200 with token, expiresIn, and guardianId", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "asst-123", actorPrincipalId: "user-456" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expiresIn: number;
      guardianId: string;
    };

    expect(typeof body.token).toBe("string");
    expect(body.token.split(".").length).toBe(3); // JWT format
    expect(body.expiresIn).toBe(3600);
    expect(body.guardianId).toBe("user-456");

    // Verify the minted token has the correct claims
    const result = verifyToken(body.token, "vellum-gateway");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("actor:asst-123:user-456");
      expect(result.claims.aud).toBe("vellum-gateway");
      expect(result.claims.scope_profile).toBe("actor_client_v1");
    }
  });

  test("missing assistantId returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ actorPrincipalId: "user-456" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("assistantId");
  });

  test("missing actorPrincipalId returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "asst-123" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("actorPrincipalId");
  });

  test("empty assistantId string returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "", actorPrincipalId: "user-456" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("assistantId");
  });

  test("empty actorPrincipalId string returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "asst-123", actorPrincipalId: "" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("actorPrincipalId");
  });

  test("whitespace-only strings return 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "   ", actorPrincipalId: "user-456" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("assistantId");
  });

  test("invalid JSON body returns 400", async () => {
    const res = await handler.handleMintToken(
      new Request(
        "http://gateway.test/v1/internal/oauth/chrome-extension/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json",
        },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("JSON");
  });

  test("non-string assistantId returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: 123, actorPrincipalId: "user-456" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("assistantId");
  });

  test("colon in assistantId returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "asst:123", actorPrincipalId: "user-456" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("colon");
  });

  test("colon in actorPrincipalId returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "asst-123", actorPrincipalId: "user:456" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("colon");
  });

  test("request without authorization header succeeds for valid payload", async () => {
    const res = await handler.handleMintToken(
      new Request(
        "http://gateway.test/v1/internal/oauth/chrome-extension/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            assistantId: "asst-123",
            actorPrincipalId: "user-456",
          }),
        },
      ),
    );
    expect(res.status).toBe(200);
  });
});

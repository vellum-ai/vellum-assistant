import { describe, test, expect, beforeAll } from "bun:test";
import "./test-preload.js";

import {
  initSigningKey,
  loadOrCreateSigningKey,
  mintToken,
  verifyToken,
} from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { createCloudOAuthTokenHandler } from "../http/routes/cloud-oauth-token.js";

beforeAll(() => {
  initSigningKey(loadOrCreateSigningKey());
});

const handler = createCloudOAuthTokenHandler();
const ASSISTANT_ID = "asst-123";
const ACTOR_PRINCIPAL_ID = "user-456";

/** Build a POST request to the cloud OAuth token endpoint. */
function makeRequest(body: unknown, authorization?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authorization) {
    headers.authorization = authorization;
  }
  return new Request(
    "http://gateway.test/v1/internal/oauth/chrome-extension/token",
    {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

describe("POST /v1/internal/oauth/chrome-extension/token", () => {
  test("happy path: valid body returns 200 with token, expiresIn, and guardianId", async () => {
    const actorToken = mintToken({
      aud: "vellum-gateway",
      sub: `actor:${ASSISTANT_ID}:${ACTOR_PRINCIPAL_ID}`,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        `Bearer ${actorToken}`,
      ),
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
    expect(body.guardianId).toBe(ACTOR_PRINCIPAL_ID);

    // Verify the minted token has the correct claims
    const result = verifyToken(body.token, "vellum-gateway");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe(
        `actor:${ASSISTANT_ID}:${ACTOR_PRINCIPAL_ID}`,
      );
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
      makeRequest({ assistantId: ASSISTANT_ID }),
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
      makeRequest({ assistantId: ASSISTANT_ID, actorPrincipalId: "" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("actorPrincipalId");
  });

  test("whitespace-only strings return 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: "   ", actorPrincipalId: ACTOR_PRINCIPAL_ID }),
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
      makeRequest({ assistantId: 123, actorPrincipalId: ACTOR_PRINCIPAL_ID }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("assistantId");
  });

  test("colon in assistantId returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({
        assistantId: "asst:123",
        actorPrincipalId: ACTOR_PRINCIPAL_ID,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("colon");
  });

  test("colon in actorPrincipalId returns 400", async () => {
    const res = await handler.handleMintToken(
      makeRequest({ assistantId: ASSISTANT_ID, actorPrincipalId: "user:456" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("colon");
  });

  test("request with invalid token returns 403", async () => {
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        "Bearer not-a-jwt",
      ),
    );
    expect(res.status).toBe(403);
  });

  test("request with mismatched actor token assistant returns 403", async () => {
    const actorToken = mintToken({
      aud: "vellum-gateway",
      sub: `actor:other-assistant:${ACTOR_PRINCIPAL_ID}`,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        `Bearer ${actorToken}`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("request with mismatched actor token principal returns 403", async () => {
    const actorToken = mintToken({
      aud: "vellum-gateway",
      sub: `actor:${ASSISTANT_ID}:other-user`,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        `Bearer ${actorToken}`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("request with non-actor service token returns 403", async () => {
    const serviceToken = mintToken({
      aud: "vellum-gateway",
      sub: "svc:gateway:self",
      scope_profile: "gateway_service_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        `Bearer ${serviceToken}`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("request without authorization header succeeds for valid payload when auth is not enforced", async () => {
    const res = await handler.handleMintToken(
      new Request(
        "http://gateway.test/v1/internal/oauth/chrome-extension/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            assistantId: ASSISTANT_ID,
            actorPrincipalId: ACTOR_PRINCIPAL_ID,
          }),
        },
      ),
    );
    expect(res.status).toBe(200);
  });

  test("request without authorization header returns 403 when auth is enforced", async () => {
    process.env.CHROME_OAUTH_TOKEN_REQUIRE_AUTH = "true";
    try {
      const res = await handler.handleMintToken(
        makeRequest({
          assistantId: ASSISTANT_ID,
          actorPrincipalId: ACTOR_PRINCIPAL_ID,
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      delete process.env.CHROME_OAUTH_TOKEN_REQUIRE_AUTH;
    }
  });
});

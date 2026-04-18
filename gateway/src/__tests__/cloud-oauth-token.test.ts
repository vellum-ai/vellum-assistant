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

let serviceToken: string;

beforeAll(() => {
  initSigningKey(loadOrCreateSigningKey());
  // Mint a service token (svc:gateway:self) that the handler accepts.
  serviceToken = mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 60,
  });
});

const handler = createCloudOAuthTokenHandler();

/** Build a POST request with the service-token Authorization header. */
function makeRequest(body: unknown): Request {
  return new Request(
    "http://gateway.test/v1/internal/oauth/chrome-extension/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceToken}`,
      },
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
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${serviceToken}`,
          },
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

  test("request without authorization header returns 403", async () => {
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
    expect(res.status).toBe(403);
  });

  test("request with actor token (not service) returns 403", async () => {
    const actorToken = mintToken({
      aud: "vellum-gateway",
      sub: "actor:asst-123:some-user",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });
    const res = await handler.handleMintToken(
      new Request(
        "http://gateway.test/v1/internal/oauth/chrome-extension/token",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${actorToken}`,
          },
          body: JSON.stringify({
            assistantId: "asst-123",
            actorPrincipalId: "user-456",
          }),
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});

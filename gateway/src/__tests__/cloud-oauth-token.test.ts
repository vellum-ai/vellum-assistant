import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "bun:test";
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
const ASSISTANT_ID = "asst-123";
const ACTOR_PRINCIPAL_ID = "user-456";
const PLATFORM_INTERNAL_API_KEY = "platform-internal-key";
const ORIGINAL_PLATFORM_INTERNAL_API_KEY =
  process.env.PLATFORM_INTERNAL_API_KEY;

beforeEach(() => {
  process.env.PLATFORM_INTERNAL_API_KEY = PLATFORM_INTERNAL_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_PLATFORM_INTERNAL_API_KEY === undefined) {
    delete process.env.PLATFORM_INTERNAL_API_KEY;
    return;
  }
  process.env.PLATFORM_INTERNAL_API_KEY = ORIGINAL_PLATFORM_INTERNAL_API_KEY;
});

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
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        `Bearer ${PLATFORM_INTERNAL_API_KEY}`,
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

  test("request without authorization header returns 403", async () => {
    const res = await handler.handleMintToken(
      makeRequest({
        assistantId: ASSISTANT_ID,
        actorPrincipalId: ACTOR_PRINCIPAL_ID,
      }),
    );
    expect(res.status).toBe(403);
  });

  test("request with invalid bearer token returns 403", async () => {
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        "Bearer wrong-internal-key",
      ),
    );
    expect(res.status).toBe(403);
  });

  test("request with non-bearer authorization header returns 403", async () => {
    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        "Api-Key some-key",
      ),
    );
    expect(res.status).toBe(403);
  });

  test("request returns 503 when PLATFORM_INTERNAL_API_KEY is not configured", async () => {
    delete process.env.PLATFORM_INTERNAL_API_KEY;

    const res = await handler.handleMintToken(
      makeRequest(
        { assistantId: ASSISTANT_ID, actorPrincipalId: ACTOR_PRINCIPAL_ID },
        `Bearer ${PLATFORM_INTERNAL_API_KEY}`,
      ),
    );
    expect(res.status).toBe(503);
  });
});

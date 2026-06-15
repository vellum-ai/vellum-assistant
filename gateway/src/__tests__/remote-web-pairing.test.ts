import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { initSigningKey, verifyToken } from "../auth/token-service.js";
import { REMOTE_WEB_SESSION_COOKIE } from "../http/remote-web-session-cookie.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

const mockQuery = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const {
  handleCreateRemoteWebPairingCode,
  handleRemoteWebPair,
  resetRemoteWebPairingForTests,
  setRemoteWebPairingNowForTests,
} = await import("../http/routes/remote-web-pairing.js");

const LOOPBACK_IP = "127.0.0.1";
const PUBLIC_BASE_URL = "https://paired.example.com";

function makeCreateRequest(
  overrides: { publicBaseUrl?: string; edgeForwarded?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    host: "localhost:7830",
    "content-type": "application/json",
  };
  if (overrides.edgeForwarded) {
    headers["x-vellum-edge-forwarded"] = "1";
  }
  return new Request("http://localhost:7830/v1/remote-web/pairing-code", {
    method: "POST",
    headers,
    body: JSON.stringify({
      publicBaseUrl: overrides.publicBaseUrl ?? PUBLIC_BASE_URL,
    }),
  });
}

function makePairRequest(
  code: string,
  overrides: {
    origin?: string;
    host?: string;
    edgeForwarded?: boolean;
  } = {},
): Request {
  const headers: Record<string, string> = {
    host: overrides.host ?? "paired.example.com",
    origin: overrides.origin ?? PUBLIC_BASE_URL,
    "content-type": "application/json",
  };
  if (overrides.edgeForwarded ?? true) {
    headers["x-vellum-edge-forwarded"] = "1";
  }
  return new Request(`${PUBLIC_BASE_URL}/v1/remote-web/pair`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code }),
  });
}

async function createCode(): Promise<string> {
  const res = await handleCreateRemoteWebPairingCode(
    makeCreateRequest(),
    LOOPBACK_IP,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string };
  return body.code;
}

function extractSessionToken(setCookie: string): string {
  const prefix = `${REMOTE_WEB_SESSION_COOKIE}=`;
  const value = setCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  expect(value).toBeDefined();
  return decodeURIComponent(value!.slice(prefix.length));
}

beforeEach(() => {
  resetRemoteWebPairingForTests();
  mockQuery.mockResolvedValue([{ principalId: "guardian-001" }]);
});

describe("remote web pairing", () => {
  test("creates a short-lived code over direct loopback", async () => {
    const res = await handleCreateRemoteWebPairingCode(
      makeCreateRequest({ publicBaseUrl: `${PUBLIC_BASE_URL}/assistant/` }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      code: string;
      expiresInSeconds: number;
      publicOrigin: string;
    };
    expect(body.code).toMatch(/^\d{3}-\d{3}$/);
    expect(body.expiresInSeconds).toBe(600);
    expect(body.publicOrigin).toBe(PUBLIC_BASE_URL);
  });

  test("rejects code creation through the nginx edge", async () => {
    const res = await handleCreateRemoteWebPairingCode(
      makeCreateRequest({ edgeForwarded: true }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(403);
  });

  test("consumes a code once and sets an HttpOnly strict same-site session cookie", async () => {
    const code = await createCode();

    const res = await handleRemoteWebPair(makePairRequest(code), LOOPBACK_IP);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${REMOTE_WEB_SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");

    const token = extractSessionToken(setCookie!);
    const result = verifyToken(token, "vellum-gateway");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.aud).toBe("vellum-gateway");
      expect(result.claims.sub).toBe("actor:self:guardian-001");
      expect(result.claims.scope_profile).toBe("actor_client_v1");
      expect(result.claims.policy_epoch).toBe(CURRENT_POLICY_EPOCH);
    }

    const replay = await handleRemoteWebPair(
      makePairRequest(code),
      LOOPBACK_IP,
    );
    expect(replay.status).toBe(401);
  });

  test("rejects remote pairing without the nginx edge marker", async () => {
    const code = await createCode();

    const res = await handleRemoteWebPair(
      makePairRequest(code, { edgeForwarded: false }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(403);
  });

  test("rejects remote pairing when origin or host does not match the code", async () => {
    const code = await createCode();

    const wrongOrigin = await handleRemoteWebPair(
      makePairRequest(code, { origin: "https://other.example.com" }),
      LOOPBACK_IP,
    );
    expect(wrongOrigin.status).toBe(403);

    const stillUnused = await handleRemoteWebPair(
      makePairRequest(code, { host: "other.example.com" }),
      LOOPBACK_IP,
    );
    expect(stillUnused.status).toBe(403);
  });

  test("rejects expired codes", async () => {
    let now = 1_000;
    setRemoteWebPairingNowForTests(() => now);
    const code = await createCode();
    now += 10 * 60 * 1000 + 1;

    const res = await handleRemoteWebPair(makePairRequest(code), LOOPBACK_IP);

    expect(res.status).toBe(401);
  });

  test("rate-limits remote pairing attempts", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await handleRemoteWebPair(
        makePairRequest("000-000"),
        LOOPBACK_IP,
      );
      expect(res.status).toBe(401);
    }

    const limited = await handleRemoteWebPair(
      makePairRequest("000-000"),
      LOOPBACK_IP,
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("20");
  });
});

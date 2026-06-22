import { beforeEach, describe, expect, test } from "bun:test";

const { handleCreateRemoteWebPairingChallenge } =
  await import("../http/routes/remote-web-pairing-challenge.js");
const {
  getRemoteWebPairingChallengeForTests,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../remote-web/pairing-challenge-store.js");
const { resetRemoteWebPairingChallengeRateLimiterForTests } =
  await import("../remote-web/pairing-challenge-rate-limit-store.js");

const LOOPBACK_IP = "127.0.0.1";
const REMOTE_IP = "203.0.113.10";
const PUBLIC_BASE_URL = "https://paired.example.com";

function makeRequest(
  overrides: {
    publicBaseUrl?: string;
    edgeForwarded?: boolean;
    host?: string;
    body?: BodyInit;
    contentLength?: number;
  } = {},
): Request {
  const headers: Record<string, string> = {
    host: overrides.host ?? "localhost:7830",
    "content-type": "application/json",
  };
  if (overrides.edgeForwarded) {
    headers["x-vellum-edge-forwarded"] = "1";
  }
  if (overrides.contentLength != null) {
    headers["content-length"] = String(overrides.contentLength);
  }
  return new Request("http://localhost:7830/v1/remote-web/pairing-challenge", {
    method: "POST",
    headers,
    body:
      overrides.body ??
      JSON.stringify({
        publicBaseUrl: overrides.publicBaseUrl ?? PUBLIC_BASE_URL,
      }),
  });
}

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
  resetRemoteWebPairingChallengeRateLimiterForTests();
});

describe("remote web pairing challenge", () => {
  test("creates an RFC-style short-lived challenge over direct loopback", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);

    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({ publicBaseUrl: `${PUBLIC_BASE_URL}/` }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresAt: string;
      expiresInSeconds: number;
      intervalSeconds: number;
    };
    expect(body.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.verificationUri).toBe(`${PUBLIC_BASE_URL}/assistant/pair`);
    expect(body.expiresAt).toBe("1970-01-01T00:10:01.000Z");
    expect(body.expiresInSeconds).toBe(600);
    expect(body.intervalSeconds).toBe(5);
  });

  test("preserves path-prefixed public base URLs in the verification URI", async () => {
    const publicBaseUrl = "https://velay.example.test/assistant-123/";

    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({ publicBaseUrl }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      verificationUri: string;
      userCode: string;
    };
    expect(body.verificationUri).toBe(
      "https://velay.example.test/assistant-123/assistant/pair",
    );

    const record = getRemoteWebPairingChallengeForTests(body.userCode);
    expect(record?.publicBaseUrl).toBe(
      "https://velay.example.test/assistant-123",
    );
  });

  test("stores only hashed challenge secrets", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest(),
      LOOPBACK_IP,
    );
    const body = (await res.json()) as {
      deviceCode: string;
      userCode: string;
    };

    const record = getRemoteWebPairingChallengeForTests(body.userCode);

    expect(record).toBeDefined();
    expect(record?.deviceCodeHash).not.toBe(body.deviceCode);
    expect(record?.userCodeHash).not.toBe(body.userCode);
    expect(record?.publicBaseUrl).toBe(PUBLIC_BASE_URL);
    expect(record?.status).toBe("pending");
  });

  test("creates a challenge through the nginx remote web edge", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
      REMOTE_IP,
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verificationUri: string;
      userCode: string;
    };
    expect(body.verificationUri).toBe(`${PUBLIC_BASE_URL}/assistant/pair`);
    expect(getRemoteWebPairingChallengeForTests(body.userCode)).toBeDefined();
  });

  test("rejects direct non-loopback challenge creation without the edge marker", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        host: "paired.example.com",
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
      REMOTE_IP,
    );

    expect(res.status).toBe(403);
  });

  test("rejects spoofed edge marker from a non-loopback peer", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
      REMOTE_IP,
      REMOTE_IP,
    );

    expect(res.status).toBe(403);
  });

  test("rejects spoofed edge marker when X-Forwarded-For appears loopback", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
      LOOPBACK_IP,
      REMOTE_IP,
    );

    expect(res.status).toBe(403);
  });

  test("rejects edge challenge creation when publicBaseUrl host does not match request host", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        publicBaseUrl: "https://attacker.example.com",
      }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "PUBLIC_BASE_URL_MISMATCH",
        message: "publicBaseUrl must match the request host",
      },
    });
  });

  test("rate limits repeated challenge creation globally across rotated public hosts", async () => {
    for (let i = 0; i < 20; i++) {
      const host = `paired-${i}.example.com`;
      const res = await handleCreateRemoteWebPairingChallenge(
        makeRequest({
          edgeForwarded: true,
          host,
          publicBaseUrl: `https://${host}/prefix-${i}`,
        }),
        LOOPBACK_IP,
      );
      expect(res.status).toBe(200);
    }

    const limited = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
      LOOPBACK_IP,
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  test("caps active challenge records even when rate limit state is reset", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);

    for (let i = 0; i < 200; i++) {
      resetRemoteWebPairingChallengeRateLimiterForTests();
      const res = await handleCreateRemoteWebPairingChallenge(
        makeRequest(),
        LOOPBACK_IP,
      );
      expect(res.status).toBe(200);
    }

    resetRemoteWebPairingChallengeRateLimiterForTests();
    const limited = await handleCreateRemoteWebPairingChallenge(
      makeRequest(),
      LOOPBACK_IP,
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("600");
    expect(await limited.json()).toEqual({
      error: {
        code: "PAIRING_CHALLENGE_CAPACITY_EXCEEDED",
        message: "too many pending remote web pairing challenges",
      },
    });
  });

  test("rejects oversized challenge request bodies", async () => {
    const body = JSON.stringify({ publicBaseUrl: "A".repeat(1024) });
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        body,
        contentLength: body.length,
      }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(413);
  });
});

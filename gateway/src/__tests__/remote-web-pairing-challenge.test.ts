import { beforeEach, describe, expect, test } from "bun:test";

const {
  getRemoteWebPairingChallengeForTests,
  handleCreateRemoteWebPairingChallenge,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../http/routes/remote-web-pairing-challenge.js");

const LOOPBACK_IP = "127.0.0.1";
const PUBLIC_BASE_URL = "https://paired.example.com";

function makeRequest(
  overrides: { publicBaseUrl?: string; edgeForwarded?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    host: "localhost:7830",
    "content-type": "application/json",
  };
  if (overrides.edgeForwarded) {
    headers["x-vellum-edge-forwarded"] = "1";
  }
  return new Request("http://localhost:7830/v1/remote-web/pairing-challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({
      publicBaseUrl: overrides.publicBaseUrl ?? PUBLIC_BASE_URL,
    }),
  });
}

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
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
  });

  test("rejects challenge creation through the nginx edge", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({ edgeForwarded: true }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(403);
  });
});

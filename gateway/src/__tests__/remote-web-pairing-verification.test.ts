import { beforeEach, describe, expect, test } from "bun:test";

const { handleCreateRemoteWebPairingChallenge } =
  await import("../http/routes/remote-web-pairing-challenge.js");
const {
  handleVerifyRemoteWebPairingChallenge,
  resetRemoteWebPairingVerificationRateLimiterForTests,
} = await import("../http/routes/remote-web-pairing-verification.js");
const {
  getRemoteWebPairingChallengeForTests,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../remote-web/pairing-challenge-store.js");

const CLIENT_IP = "203.0.113.10";
const LOOPBACK_IP = "127.0.0.1";
const PUBLIC_BASE_URL = "https://paired.example.com";

function makeChallengeRequest(): Request {
  return new Request("http://localhost:7830/v1/remote-web/pairing-challenge", {
    method: "POST",
    headers: {
      host: "localhost:7830",
      "content-type": "application/json",
    },
    body: JSON.stringify({ publicBaseUrl: PUBLIC_BASE_URL }),
  });
}

function makeVerificationRequest(body: unknown): Request {
  return new Request(
    "https://paired.example.com/v1/remote-web/pairing-verification",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function createChallenge(): Promise<{
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}> {
  const res = await handleCreateRemoteWebPairingChallenge(
    makeChallengeRequest(),
    LOOPBACK_IP,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    userCode: string;
    verificationUri: string;
    expiresAt: string;
  };
}

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
  resetRemoteWebPairingVerificationRateLimiterForTests();
});

describe("remote web pairing verification", () => {
  test("approves a pending challenge by user code", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = await createChallenge();

    const res = await handleVerifyRemoteWebPairingChallenge(
      makeVerificationRequest({
        userCode: challenge.userCode.replace("-", "").toLowerCase(),
      }),
      CLIENT_IP,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "approved",
      verificationUri: challenge.verificationUri,
      expiresAt: challenge.expiresAt,
    });

    const record = getRemoteWebPairingChallengeForTests(challenge.userCode);
    expect(record?.status).toBe("approved");
    expect(record?.approvedAtMs).toBe(1_000);
  });

  test("expires stale challenges instead of approving them", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = await createChallenge();
    setRemoteWebPairingChallengeNowForTests(() => 601_000);

    const res = await handleVerifyRemoteWebPairingChallenge(
      makeVerificationRequest({ userCode: challenge.userCode }),
      CLIENT_IP,
    );

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: {
        code: "EXPIRED_USER_CODE",
        message: "pairing code expired",
      },
    });
    expect(getRemoteWebPairingChallengeForTests(challenge.userCode)).toBe(
      undefined,
    );
  });

  test("rate limits repeated failed verification attempts", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await handleVerifyRemoteWebPairingChallenge(
        makeVerificationRequest({ userCode: `BAD-${i}` }),
        CLIENT_IP,
      );
      expect(res.status).toBe(404);
    }

    const limited = await handleVerifyRemoteWebPairingChallenge(
      makeVerificationRequest({ userCode: "BAD-10" }),
      CLIENT_IP,
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();

    const challenge = await createChallenge();
    const approved = await handleVerifyRemoteWebPairingChallenge(
      makeVerificationRequest({ userCode: challenge.userCode }),
      CLIENT_IP,
    );

    expect(approved.status).toBe(200);
  });
});

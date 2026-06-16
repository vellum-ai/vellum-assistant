import { beforeEach, describe, expect, test } from "bun:test";

const { handleCreateRemoteWebPairingChallenge } =
  await import("../http/routes/remote-web-pairing-challenge.js");
const { handleVerifyRemoteWebPairingChallenge } =
  await import("../http/routes/remote-web-pairing-verification.js");
const {
  getRemoteWebPairingChallengeForTests,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../remote-web/pairing-challenge-store.js");
const { resetRemoteWebPairingVerificationRateLimiterForTests } =
  await import("../remote-web/pairing-verification-rate-limit-store.js");

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
  return makeRawVerificationRequest(JSON.stringify(body));
}

function makeRawVerificationRequest(
  body: BodyInit,
  headers: Record<string, string> = {},
): Request {
  return new Request(
    "https://paired.example.com/v1/remote-web/pairing-verification",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    },
  );
}

function makeTrackedBodyAccessVerificationRequest(): {
  req: Request;
  getBodyAccessCount: () => number;
} {
  let bodyAccessCount = 0;
  const req = {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    get body() {
      bodyAccessCount += 1;
      return new ReadableStream<Uint8Array>();
    },
  } as unknown as Request;

  return {
    req,
    getBodyAccessCount: () => bodyAccessCount,
  };
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
    const blockedValidCode = await handleVerifyRemoteWebPairingChallenge(
      makeVerificationRequest({ userCode: challenge.userCode }),
      CLIENT_IP,
    );

    expect(blockedValidCode.status).toBe(429);
    expect(
      getRemoteWebPairingChallengeForTests(challenge.userCode)?.status,
    ).toBe("pending");

    const tracked = makeTrackedBodyAccessVerificationRequest();
    const blockedUnreadBody = await handleVerifyRemoteWebPairingChallenge(
      tracked.req,
      CLIENT_IP,
    );

    expect(blockedUnreadBody.status).toBe(429);
    expect(tracked.getBodyAccessCount()).toBe(0);
  });

  test("rejects oversized verification bodies", async () => {
    const body = JSON.stringify({ userCode: "A".repeat(512) });
    const res = await handleVerifyRemoteWebPairingChallenge(
      makeRawVerificationRequest(body, {
        "content-length": String(body.length),
      }),
      CLIENT_IP,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "request body too large",
      },
    });
  });
});

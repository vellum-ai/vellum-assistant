import { beforeEach, describe, expect, test } from "bun:test";

const { handleCreateRemoteWebPairingChallenge } =
  await import("../http/routes/remote-web-pairing-challenge.js");
const {
  handleApproveRemoteWebPairingRequest,
  handleDenyRemoteWebPairingRequest,
  handleListRemoteWebPairingRequests,
} = await import("../http/routes/remote-web-pairing-requests.js");
const {
  claimRemoteWebPairingChallengeExchange,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../remote-web/pairing-challenge-store.js");

import {
  LOOPBACK_IP,
  makeLocalRequest,
  makeRemoteRequest,
  PUBLIC_BASE_URL,
  REMOTE_IP as CLIENT_IP,
} from "./helpers/remote-web-pairing-fixtures.js";

const LIST_PATH = "/v1/remote-web/pairing-requests";
const APPROVE_PATH = "/v1/remote-web/pairing-requests/approve";
const DENY_PATH = "/v1/remote-web/pairing-requests/deny";

function makeActionRequest(path: string, body: unknown): Request {
  return makeLocalRequest(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function createChallenge(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}> {
  const res = await handleCreateRemoteWebPairingChallenge(
    makeLocalRequest("/v1/remote-web/pairing-challenge", {
      method: "POST",
      body: JSON.stringify({ publicBaseUrl: PUBLIC_BASE_URL }),
      headers: { "user-agent": "test-suite/1.0" },
    }),
    LOOPBACK_IP,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
  };
}

interface ListedRequest {
  requestId: string;
  userCode: string;
  publicBaseUrl: string;
  viaEdgeProxy: boolean;
}

async function listRequests(): Promise<ListedRequest[]> {
  const res = handleListRemoteWebPairingRequests(
    makeLocalRequest(LIST_PATH, { method: "GET" }),
    LOOPBACK_IP,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as { requests: ListedRequest[] };
  return body.requests;
}

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
});

describe("remote web pairing requests", () => {
  test("rejects non-loopback callers on all three routes", async () => {
    const responses = await Promise.all([
      handleListRemoteWebPairingRequests(
        makeRemoteRequest(LIST_PATH, { method: "GET" }),
        CLIENT_IP,
      ),
      handleApproveRemoteWebPairingRequest(
        makeRemoteRequest(APPROVE_PATH, {
          method: "POST",
          body: JSON.stringify({ requestId: "some-id" }),
        }),
        CLIENT_IP,
      ),
      handleDenyRemoteWebPairingRequest(
        makeRemoteRequest(DENY_PATH, {
          method: "POST",
          body: JSON.stringify({ requestId: "some-id" }),
        }),
        CLIENT_IP,
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "FORBIDDEN", message: "endpoint is local-only" },
      });
    }
  });

  test("rejects wrong methods", async () => {
    const listPost = handleListRemoteWebPairingRequests(
      makeLocalRequest(LIST_PATH, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      LOOPBACK_IP,
    );
    expect(listPost.status).toBe(405);
    expect(listPost.headers.get("Allow")).toBe("GET");

    const approveGet = await handleApproveRemoteWebPairingRequest(
      makeLocalRequest(APPROVE_PATH, { method: "GET" }),
      LOOPBACK_IP,
    );
    expect(approveGet.status).toBe(405);
    expect(approveGet.headers.get("Allow")).toBe("POST");

    const denyGet = await handleDenyRemoteWebPairingRequest(
      makeLocalRequest(DENY_PATH, { method: "GET" }),
      LOOPBACK_IP,
    );
    expect(denyGet.status).toBe(405);
    expect(denyGet.headers.get("Allow")).toBe("POST");
  });

  test("lists a pending challenge and approves it end to end", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = await createChallenge();

    const requests = await listRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userCode).toBe(challenge.userCode);
    expect(requests[0]?.publicBaseUrl).toBe(PUBLIC_BASE_URL);
    expect(requests[0]?.viaEdgeProxy).toBe(false);

    const approveRes = await handleApproveRemoteWebPairingRequest(
      makeActionRequest(APPROVE_PATH, { requestId: requests[0]?.requestId }),
      LOOPBACK_IP,
    );
    expect(approveRes.status).toBe(200);
    expect(approveRes.headers.get("Cache-Control")).toBe("no-store");
    expect(await approveRes.json()).toEqual({
      status: "approved",
      verificationUri: challenge.verificationUri,
      expiresAt: challenge.expiresAt,
    });

    const exchange = claimRemoteWebPairingChallengeExchange(
      challenge.deviceCode,
    );
    expect(exchange.status).toBe("approved");
  });

  test("denies a pending challenge so the exchange poll sees invalid", async () => {
    const challenge = await createChallenge();
    const requests = await listRequests();
    expect(requests).toHaveLength(1);

    const denyRes = await handleDenyRemoteWebPairingRequest(
      makeActionRequest(DENY_PATH, { requestId: requests[0]?.requestId }),
      LOOPBACK_IP,
    );
    expect(denyRes.status).toBe(200);
    expect(await denyRes.json()).toEqual({ status: "denied" });

    expect(await listRequests()).toHaveLength(0);
    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("invalid");
  });

  test("returns 409 ALREADY_APPROVED when denying an approved request", async () => {
    const challenge = await createChallenge();
    const requests = await listRequests();
    expect(requests).toHaveLength(1);

    const approveRes = await handleApproveRemoteWebPairingRequest(
      makeActionRequest(APPROVE_PATH, { requestId: requests[0]?.requestId }),
      LOOPBACK_IP,
    );
    expect(approveRes.status).toBe(200);

    const denyRes = await handleDenyRemoteWebPairingRequest(
      makeActionRequest(DENY_PATH, { requestId: requests[0]?.requestId }),
      LOOPBACK_IP,
    );
    expect(denyRes.status).toBe(409);
    expect(await denyRes.json()).toEqual({
      error: {
        code: "ALREADY_APPROVED",
        message: "this pairing request was already approved on another surface",
      },
    });

    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("approved");
  });

  test("returns 404 for unknown request ids", async () => {
    const approveRes = await handleApproveRemoteWebPairingRequest(
      makeActionRequest(APPROVE_PATH, { requestId: "nope" }),
      LOOPBACK_IP,
    );
    expect(approveRes.status).toBe(404);
    expect(await approveRes.json()).toEqual({
      error: { code: "INVALID_REQUEST_ID", message: "unknown pairing request" },
    });

    const denyRes = await handleDenyRemoteWebPairingRequest(
      makeActionRequest(DENY_PATH, { requestId: "nope" }),
      LOOPBACK_IP,
    );
    expect(denyRes.status).toBe(404);
    expect(await denyRes.json()).toEqual({
      error: { code: "INVALID_REQUEST_ID", message: "unknown pairing request" },
    });
  });

  test("returns 410 when approving an expired challenge", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    await createChallenge();
    const requests = await listRequests();
    expect(requests).toHaveLength(1);

    setRemoteWebPairingChallengeNowForTests(() => 601_000);
    const res = await handleApproveRemoteWebPairingRequest(
      makeActionRequest(APPROVE_PATH, { requestId: requests[0]?.requestId }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: { code: "EXPIRED_REQUEST", message: "pairing request expired" },
    });
  });

  test("rejects malformed action bodies", async () => {
    for (const body of [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ requestId: "  " }),
    ]) {
      const res = await handleApproveRemoteWebPairingRequest(
        makeLocalRequest(APPROVE_PATH, { method: "POST", body }),
        LOOPBACK_IP,
      );
      expect(res.status).toBe(400);
    }
  });

  test("rejects oversized action bodies", async () => {
    const body = JSON.stringify({ requestId: "A".repeat(512) });
    const res = await handleApproveRemoteWebPairingRequest(
      makeLocalRequest(APPROVE_PATH, {
        method: "POST",
        body,
        headers: { "content-length": String(body.length) },
      }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "request body too large" },
    });
  });
});

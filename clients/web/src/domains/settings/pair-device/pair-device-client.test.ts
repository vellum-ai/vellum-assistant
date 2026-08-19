import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  approvePairingRequest,
  denyPairingRequest,
  listPendingPairingRequests,
  mintDevicePairing,
  pairingConnectivityHint,
  PairDeviceError,
} from "./pair-device-client";
import {
  fetchLog,
  installFetch,
  jsonResponse,
  pendingRequest,
  requestBody,
  resetFetchLog,
  restoreFetch,
  TEST_GATEWAY_BASE as BASE,
} from "./pair-device-test-helpers";

async function capturePairDeviceError(
  promise: Promise<unknown>,
): Promise<PairDeviceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PairDeviceError);
    return err as PairDeviceError;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(() => {
  resetFetchLog();
});

afterEach(() => {
  restoreFetch();
});

describe("listPendingPairingRequests", () => {
  test("GETs the list route with no auth header and returns the requests", async () => {
    installFetch(() => jsonResponse({ requests: [pendingRequest()] }));

    const result = await listPendingPairingRequests({ base: BASE });

    await expect(result).toEqual([pendingRequest()]);
    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0]?.url).toBe(`${BASE}/v1/remote-web/pairing-requests`);
    expect(fetchLog[0]?.init?.method).toBe("GET");
    expect(fetchLog[0]?.init?.body).toBeUndefined();
    expect(
      new Headers(fetchLog[0]?.init?.headers).get("Authorization"),
    ).toBeNull();
  });

  test("returns [] when the requests field is missing", async () => {
    installFetch(() => jsonResponse({}));

    expect(await listPendingPairingRequests({ base: BASE })).toEqual([]);
  });

  test("returns [] when the requests field is not an array", async () => {
    installFetch(() => jsonResponse({ requests: "nope" }));

    expect(await listPendingPairingRequests({ base: BASE })).toEqual([]);
  });

  test("throws PairDeviceError with the server's message and no hint on a non-OK response", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "Not available." } }, 503),
    );

    const err = await capturePairDeviceError(
      listPendingPairingRequests({ base: BASE }),
    );
    expect(err.message).toBe("Not available.");
    expect(err.hint).toBeUndefined();
  });

  test("falls back to a status message when the error body is not JSON", async () => {
    installFetch(() => new Response("<html>oops</html>", { status: 500 }));

    await expect(listPendingPairingRequests({ base: BASE })).rejects.toThrow(
      "Pairing failed (HTTP 500).",
    );
  });

  test("maps a network failure to a PairDeviceError with no status", async () => {
    installFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const err = await capturePairDeviceError(
      listPendingPairingRequests({ base: BASE }),
    );
    expect(err.message).toBe(
      "Couldn't reach the assistant. Make sure it's running and try again.",
    );
    expect(err.status).toBeUndefined();
  });

  test("rethrows AbortError when the caller cancels", async () => {
    installFetch(() => {
      throw new DOMException("Aborted", "AbortError");
    });
    const controller = new AbortController();

    await expect(
      listPendingPairingRequests({ base: BASE, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("passes the abort signal through to fetch", async () => {
    installFetch(() => jsonResponse({ requests: [] }));
    const controller = new AbortController();

    await listPendingPairingRequests({ base: BASE, signal: controller.signal });

    await expect(fetchLog[0]?.init?.signal).toBe(controller.signal);
  });
});

describe("approvePairingRequest", () => {
  test("POSTs the requestId to the approve route with no auth header", async () => {
    installFetch(() =>
      jsonResponse({
        status: "approved",
        verificationUri: "https://foo.ts.net/assistant/pair",
        expiresAt: "2026-08-17T10:10:00.000Z",
      }),
    );

    await approvePairingRequest({ base: BASE, requestId: "req-1" });

    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0]?.url).toBe(
      `${BASE}/v1/remote-web/pairing-requests/approve`,
    );
    expect(fetchLog[0]?.init?.method).toBe("POST");
    expect(requestBody(fetchLog[0])).toEqual({ requestId: "req-1" });
    const headers = new Headers(fetchLog[0]?.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBeNull();
  });

  test("throws PairDeviceError with the server's message and no hint on a non-OK response", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "Unknown request." } }, 404),
    );

    const err = await capturePairDeviceError(
      approvePairingRequest({ base: BASE, requestId: "req-x" }),
    );
    expect(err.message).toBe("Unknown request.");
    expect(err.hint).toBeUndefined();
    expect(err.status).toBe(404);
  });

  test("maps a network failure to PairDeviceError", async () => {
    installFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      approvePairingRequest({ base: BASE, requestId: "req-1" }),
    ).rejects.toThrow(
      "Couldn't reach the assistant. Make sure it's running and try again.",
    );
  });

  test("passes the abort signal through to fetch", async () => {
    installFetch(() =>
      jsonResponse({
        status: "approved",
        verificationUri: "https://foo.ts.net/assistant/pair",
        expiresAt: "2026-08-17T10:10:00.000Z",
      }),
    );
    const controller = new AbortController();

    await approvePairingRequest({
      base: BASE,
      requestId: "req-1",
      signal: controller.signal,
    });

    await expect(fetchLog[0]?.init?.signal).toBe(controller.signal);
  });
});

describe("denyPairingRequest", () => {
  test("POSTs the requestId to the deny route with no auth header", async () => {
    installFetch(() => jsonResponse({ status: "denied" }));

    await denyPairingRequest({ base: BASE, requestId: "req-1" });

    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0]?.url).toBe(
      `${BASE}/v1/remote-web/pairing-requests/deny`,
    );
    expect(fetchLog[0]?.init?.method).toBe("POST");
    expect(requestBody(fetchLog[0])).toEqual({ requestId: "req-1" });
    expect(
      new Headers(fetchLog[0]?.init?.headers).get("Authorization"),
    ).toBeNull();
  });

  test("throws PairDeviceError with the server's message and no hint on a non-OK response", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "Request expired." } }, 410),
    );

    const err = await capturePairDeviceError(
      denyPairingRequest({ base: BASE, requestId: "req-1" }),
    );
    expect(err.message).toBe("Request expired.");
    expect(err.hint).toBeUndefined();
    expect(err.status).toBe(410);
  });

  test("carries the server's error code for conflict handling", async () => {
    installFetch(() =>
      jsonResponse(
        {
          error: {
            code: "ALREADY_APPROVED",
            message: "Request already approved on another surface.",
          },
        },
        409,
      ),
    );

    const err = await capturePairDeviceError(
      denyPairingRequest({ base: BASE, requestId: "req-1" }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("ALREADY_APPROVED");
  });

  test("rethrows AbortError when the caller cancels", async () => {
    installFetch(() => {
      throw new DOMException("Aborted", "AbortError");
    });
    const controller = new AbortController();

    await expect(
      denyPairingRequest({
        base: BASE,
        requestId: "req-1",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("mintDevicePairing", () => {
  const MINT_ARGS = { base: BASE, publicBaseUrl: "https://foo.ts.net" };
  const CHALLENGE_URL = `${BASE}/v1/remote-web/pairing-challenge`;
  const VERIFICATION_URL = `${BASE}/v1/remote-web/pairing-verification`;
  const LIST_URL = `${BASE}/v1/remote-web/pairing-requests`;
  const DENY_URL = `${LIST_URL}/deny`;

  function challengeResponse(): Response {
    return jsonResponse({
      userCode: "WXYZ-1234",
      deviceCode: "device-code-1",
      verificationUri: "https://foo.ts.net/assistant/pair",
      expiresAt: "2026-08-17T10:10:00.000Z",
    });
  }

  test("attaches the connectivity hint when the challenge mint is rejected", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "Mint refused." } }, 403),
    );

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));
    expect(err.message).toBe("Mint refused.");
    expect(err.hint).toBe(pairingConnectivityHint());
    // The challenge never minted, so there is no orphan to clean up.
    expect(fetchLog.map((r) => r.url)).toEqual([CHALLENGE_URL]);
  });

  test("attaches the connectivity hint when the verification step is rejected", async () => {
    installFetch((url) =>
      url === CHALLENGE_URL
        ? challengeResponse()
        : jsonResponse({ error: { message: "Verification failed." } }, 400),
    );

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));
    expect(err.message).toBe("Verification failed.");
    expect(err.hint).toBe(pairingConnectivityHint());
  });

  test("denies its orphaned challenge when the verification step fails", async () => {
    installFetch((url) => {
      switch (url) {
        case CHALLENGE_URL:
          return challengeResponse();
        case VERIFICATION_URL:
          return jsonResponse(
            { error: { message: "Verification failed." } },
            400,
          );
        case LIST_URL:
          return jsonResponse({
            requests: [
              pendingRequest({ requestId: "req-other", userCode: "AAAA-0000" }),
              pendingRequest({
                requestId: "req-orphan",
                userCode: "WXYZ-1234",
              }),
            ],
          });
        case DENY_URL:
          return jsonResponse({ status: "denied" });
        default:
          throw new Error(`unexpected fetch: ${url}`);
      }
    });

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));

    // The original mint error propagates unchanged.
    expect(err.message).toBe("Verification failed.");
    expect(err.hint).toBe(pairingConnectivityHint());
    // Cleanup listed the pending requests and denied the matching userCode.
    expect(fetchLog.map((r) => r.url)).toEqual([
      CHALLENGE_URL,
      VERIFICATION_URL,
      LIST_URL,
      DENY_URL,
    ]);
    expect(requestBody(fetchLog[3])).toEqual({ requestId: "req-orphan" });
  });

  test("skips the deny when no pending row matches the minted userCode", async () => {
    installFetch((url) => {
      switch (url) {
        case CHALLENGE_URL:
          return challengeResponse();
        case VERIFICATION_URL:
          return jsonResponse(
            { error: { message: "Verification failed." } },
            400,
          );
        case LIST_URL:
          return jsonResponse({
            requests: [
              pendingRequest({ requestId: "req-other", userCode: "AAAA-0000" }),
            ],
          });
        default:
          throw new Error(`unexpected fetch: ${url}`);
      }
    });

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));

    expect(err.message).toBe("Verification failed.");
    expect(fetchLog.map((r) => r.url)).toEqual([
      CHALLENGE_URL,
      VERIFICATION_URL,
      LIST_URL,
    ]);
  });

  test("a cleanup failure does not mask the original mint error", async () => {
    installFetch((url) => {
      switch (url) {
        case CHALLENGE_URL:
          return challengeResponse();
        case VERIFICATION_URL:
          return jsonResponse(
            { error: { message: "Verification failed." } },
            400,
          );
        case LIST_URL:
          return jsonResponse({ error: { message: "List broken." } }, 500);
        default:
          throw new Error(`unexpected fetch: ${url}`);
      }
    });

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));

    expect(err.message).toBe("Verification failed.");
    expect(err.hint).toBe(pairingConnectivityHint());
    expect(fetchLog.map((r) => r.url)).toEqual([
      CHALLENGE_URL,
      VERIFICATION_URL,
      LIST_URL,
    ]);
  });

  test("fires cleanup without awaiting it when the caller aborts during verification", async () => {
    let resolveList!: (response: Response) => void;
    installFetch((url) => {
      switch (url) {
        case CHALLENGE_URL:
          return challengeResponse();
        case VERIFICATION_URL:
          throw new DOMException("Aborted", "AbortError");
        case LIST_URL:
          return new Promise<Response>((resolve) => {
            resolveList = resolve;
          });
        case DENY_URL:
          return jsonResponse({ status: "denied" });
        default:
          throw new Error(`unexpected fetch: ${url}`);
      }
    });
    const controller = new AbortController();

    // The AbortError rethrows while the cleanup list is still in flight.
    await expect(
      mintDevicePairing({ ...MINT_ARGS, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchLog.map((r) => r.url)).toEqual([
      CHALLENGE_URL,
      VERIFICATION_URL,
      LIST_URL,
    ]);
    // Cleanup runs on its own timeout signal, never the caller's.
    const listSignal = fetchLog[2]?.init?.signal;
    expect(listSignal).not.toBe(controller.signal);
    expect(listSignal?.aborted).toBe(false);

    resolveList(
      jsonResponse({
        requests: [
          pendingRequest({ requestId: "req-orphan", userCode: "WXYZ-1234" }),
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchLog.map((r) => r.url)).toEqual([
      CHALLENGE_URL,
      VERIFICATION_URL,
      LIST_URL,
      DENY_URL,
    ]);
    expect(requestBody(fetchLog[3])).toEqual({ requestId: "req-orphan" });
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  approvePairingRequest,
  denyPairingRequest,
  listPendingPairingRequests,
  mintDevicePairing,
  PAIRING_CONNECTIVITY_HINT,
  PairDeviceError,
} from "./pair-device-client";

const BASE = "http://localhost:3000/assistant/__gateway/20100";

const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit | undefined }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(respond: (url: string) => Response | Promise<Response>) {
  const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({ url, init });
    return respond(url);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function pendingRequest() {
  return {
    requestId: "req-1",
    userCode: "WXYZ-1234",
    publicBaseUrl: "https://foo.ts.net",
    requestedAt: "2026-08-17T10:00:00.000Z",
    expiresAt: "2026-08-17T10:10:00.000Z",
    requesterIp: "203.0.113.7",
    requesterUserAgent: "Mozilla/5.0",
  };
}

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
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("listPendingPairingRequests", () => {
  test("GETs the list route with no auth header and returns the requests", async () => {
    installFetch(() => jsonResponse({ requests: [pendingRequest()] }));

    const result = await listPendingPairingRequests({ base: BASE });

    await expect(result).toEqual([pendingRequest()]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${BASE}/v1/remote-web/pairing-requests`);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(
      new Headers(requests[0]?.init?.headers).get("Authorization"),
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

    await expect(requests[0]?.init?.signal).toBe(controller.signal);
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

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `${BASE}/v1/remote-web/pairing-requests/approve`,
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({
      requestId: "req-1",
    });
    const headers = new Headers(requests[0]?.init?.headers);
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

    await expect(requests[0]?.init?.signal).toBe(controller.signal);
  });
});

describe("denyPairingRequest", () => {
  test("POSTs the requestId to the deny route with no auth header", async () => {
    installFetch(() => jsonResponse({ status: "denied" }));

    await denyPairingRequest({ base: BASE, requestId: "req-1" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `${BASE}/v1/remote-web/pairing-requests/deny`,
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({
      requestId: "req-1",
    });
    expect(
      new Headers(requests[0]?.init?.headers).get("Authorization"),
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

  test("attaches the connectivity hint when the challenge mint is rejected", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "Mint refused." } }, 403),
    );

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));
    expect(err.message).toBe("Mint refused.");
    expect(err.hint).toBe(PAIRING_CONNECTIVITY_HINT);
  });

  test("attaches the connectivity hint when the verification step is rejected", async () => {
    installFetch((url) =>
      url.endsWith("/v1/remote-web/pairing-challenge")
        ? jsonResponse({
            userCode: "WXYZ-1234",
            deviceCode: "device-code-1",
            verificationUri: "https://foo.ts.net/assistant/pair",
            expiresAt: "2026-08-17T10:10:00.000Z",
          })
        : jsonResponse({ error: { message: "Verification failed." } }, 400),
    );

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));
    expect(err.message).toBe("Verification failed.");
    expect(err.hint).toBe(PAIRING_CONNECTIVITY_HINT);
  });
});

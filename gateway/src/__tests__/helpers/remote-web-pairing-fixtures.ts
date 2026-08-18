/** Shared constants and request factories for the remote-web pairing tests. */

export const LOOPBACK_IP = "127.0.0.1";
export const REMOTE_IP = "203.0.113.10";
export const PUBLIC_BASE_URL = "https://paired.example.com";

/** Requester metadata for challenges minted directly against the store. */
export const TEST_REQUESTER = {
  ip: REMOTE_IP,
  userAgent: "PairBrowser/1.0",
  viaEdgeProxy: true,
};

/** A request as sent by a local loopback client (host machine). */
export function makeLocalRequest(
  path: string,
  init: {
    method: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  },
): Request {
  return new Request(`http://localhost:7830${path}`, {
    method: init.method,
    headers: {
      host: "localhost:7830",
      "content-type": "application/json",
      ...init.headers,
    },
    body: init.body,
  });
}

/** A request as sent by a remote (non-loopback) caller. */
export function makeRemoteRequest(
  path: string,
  init: { method: string; body?: BodyInit },
): Request {
  return new Request(`https://paired.example.com${path}`, {
    method: init.method,
    headers: {
      host: "paired.example.com",
      "content-type": "application/json",
    },
    body: init.body,
  });
}

/** A mint request against the pairing-challenge route. */
export function makePairingChallengeRequest(
  overrides: {
    publicBaseUrl?: string;
    edgeForwarded?: boolean;
    edgeClientIp?: string;
    host?: string;
    body?: BodyInit;
    contentLength?: number;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (overrides.host) {
    headers.host = overrides.host;
  }
  if (overrides.edgeForwarded) {
    headers["x-vellum-edge-forwarded"] = "1";
  }
  if (overrides.edgeClientIp) {
    headers["x-vellum-client-ip"] = overrides.edgeClientIp;
  }
  if (overrides.contentLength != null) {
    headers["content-length"] = String(overrides.contentLength);
  }
  return makeLocalRequest("/v1/remote-web/pairing-challenge", {
    method: "POST",
    headers,
    body:
      overrides.body ??
      JSON.stringify({
        publicBaseUrl: overrides.publicBaseUrl ?? PUBLIC_BASE_URL,
      }),
  });
}

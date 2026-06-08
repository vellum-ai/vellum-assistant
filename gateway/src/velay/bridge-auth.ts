import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";

/**
 * Process-local proof that a loopback request was opened by this gateway's
 * Velay tunnel bridge. Direct callers can know the header name, but not the
 * per-process value.
 */
export const VELAY_BRIDGE_AUTH_HEADER = "x-vellum-velay-bridge-auth" as const;

const bridgeAuthValue = randomBytes(32).toString("base64url");

export function addVelayBridgeAuthHeader(
  headers: OutgoingHttpHeaders,
): OutgoingHttpHeaders {
  headers[VELAY_BRIDGE_AUTH_HEADER] = bridgeAuthValue;
  return headers;
}

export function setVelayBridgeAuthHeader(headers: Headers): void {
  headers.set(VELAY_BRIDGE_AUTH_HEADER, bridgeAuthValue);
}

export function requestHasVelayBridgeAuth(req: Request): boolean {
  const value = req.headers.get(VELAY_BRIDGE_AUTH_HEADER);
  if (!value) return false;

  const actual = Buffer.from(value);
  const expected = Buffer.from(bridgeAuthValue);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

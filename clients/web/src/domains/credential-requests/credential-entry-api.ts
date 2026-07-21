/**
 * Public (unauthenticated) gateway API for one-time credential-request links.
 *
 * The credential entry page is served by the self-hosted gateway itself, so
 * these calls use the same base-URL mechanics as the remote-web pairing page:
 * plain `fetch()` against the current origin, with the public ingress path
 * prefix (if any) prepended via `remoteGatewayApiPath()` — see
 * `lib/auth/remote-gateway-session.ts`. No auth header is attached; the
 * single-use token is the only authorization, and it always travels in the
 * request BODY (never the URL path) so it can't leak into access logs,
 * proxies, or browser history.
 */

import { remoteGatewayApiPath } from "@/lib/auth/remote-gateway-session";

const PEEK_PATH = "/v1/credential-requests/peek";
const SUBMIT_PATH = "/v1/credential-requests/submit";

/** Metadata about a pending credential request, from `peek`. */
export interface CredentialRequestDetails {
  service: string;
  field: string;
  label: string | null;
  /** Epoch timestamp (seconds or milliseconds — normalize before use). */
  expiresAt: number;
}

export type CredentialPeekResult =
  | { status: "ok"; request: CredentialRequestDetails }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "used" }
  | { status: "error" };

export type CredentialSubmitResult =
  | { status: "ok" }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "used" }
  | { status: "store-failed" }
  | { status: "error" };

/** Normalize an epoch that may be seconds or milliseconds to milliseconds. */
export function credentialExpiryToEpochMs(value: number): number {
  return value > 1_000_000_000_000 ? value : value * 1000;
}

/**
 * Interpret the gateway's token-error envelope
 * `{ error: { code: "INVALID" | "EXPIRED" | "USED", message } }`.
 */
function tokenErrorStatus(
  body: unknown,
): "invalid" | "expired" | "used" | null {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (code === "INVALID") {
    return "invalid";
  }
  if (code === "EXPIRED") {
    return "expired";
  }
  if (code === "USED") {
    return "used";
  }
  return null;
}

function isPeekPayload(value: unknown): value is CredentialRequestDetails {
  const payload = value as Partial<CredentialRequestDetails> | null;
  return (
    typeof payload?.service === "string" &&
    typeof payload.field === "string" &&
    (payload.label === null || typeof payload.label === "string") &&
    typeof payload.expiresAt === "number"
  );
}

/**
 * Look up a credential request by its single-use token without consuming it.
 * Rejects only on fetch-level failures (network error, abort); HTTP error
 * statuses are mapped into the result union.
 */
export async function peekCredentialRequest(
  token: string,
  signal?: AbortSignal,
): Promise<CredentialPeekResult> {
  const response = await fetch(remoteGatewayApiPath(PEEK_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    signal,
  });
  // A non-JSON body (e.g. an HTML error page) resolves to null and falls
  // through to the status checks below.
  const body = (await response.json().catch(() => null)) as unknown;

  if (response.ok && isPeekPayload(body)) {
    return { status: "ok", request: body };
  }
  if (response.status === 404) {
    return { status: tokenErrorStatus(body) ?? "invalid" };
  }
  return { status: "error" };
}

/**
 * Submit the secret value for a credential request, consuming the token.
 * Rejects only on fetch-level failures (network error, abort); HTTP error
 * statuses are mapped into the result union.
 */
export async function submitCredentialRequest(
  token: string,
  value: string,
  signal?: AbortSignal,
): Promise<CredentialSubmitResult> {
  const response = await fetch(remoteGatewayApiPath(SUBMIT_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, value }),
    signal,
  });

  if (response.ok) {
    return { status: "ok" };
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (response.status === 404) {
    return { status: tokenErrorStatus(body) ?? "invalid" };
  }
  if (response.status === 502) {
    return { status: "store-failed" };
  }
  return { status: "error" };
}

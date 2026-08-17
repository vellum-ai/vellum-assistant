/**
 * Browser side of the `vellum pair --qr` flow. In desktop/local mode the SPA
 * reaches the same-machine gateway over its loopback proxy
 * (`/assistant/__gateway/<port>`) and drives the two loopback-only routes the
 * CLI uses:
 *   1. `POST /v1/remote-web/pairing-challenge` — mint a device-code challenge.
 *   2. `POST /v1/remote-web/pairing-verification` — approve it with the user
 *      code. Running on the host IS the authorization, so the scan alone
 *      completes pairing.
 *
 * It also drives the request-approval routes behind the settings surface that
 * lists pairing requests minted elsewhere (e.g. the public `/assistant/pair`
 * page) so the host can approve or deny them by request id:
 *   3. `GET  /v1/remote-web/pairing-requests`: list pending requests.
 *   4. `POST /v1/remote-web/pairing-requests/approve`: approve one.
 *   5. `POST /v1/remote-web/pairing-requests/deny`: deny one.
 *
 * All these routes are loopback-gated and unauthenticated (they refuse any
 * non-loopback origin server-side), so no token is attached: the loopback
 * proxy is the trust boundary. Minting and approval are possible only from the
 * host; a remote paired session can never reach these routes, which is why the
 * UI is hidden outside local mode rather than relying on a client-side check.
 */

import type {
  RemoteWebPairingChallengeRequest,
  RemoteWebPairingChallengeResponse,
  RemoteWebPairingRequestActionRequest,
  RemoteWebPairingRequestListResponse,
  RemoteWebPairingRequestSummary,
  RemoteWebPairingVerificationRequest,
} from "@vellumai/service-contracts/remote-web-pairing";

import { getLocalGatewayUrl, getSelectedAssistant } from "@/lib/local-mode";

import { buildRemoteWebPairingUrl } from "./pair-device-url";

const PAIRING_CHALLENGE_PATH = "/v1/remote-web/pairing-challenge";
const PAIRING_VERIFICATION_PATH = "/v1/remote-web/pairing-verification";
const PAIRING_REQUESTS_PATH = "/v1/remote-web/pairing-requests";
const PAIRING_REQUEST_APPROVE_PATH = `${PAIRING_REQUESTS_PATH}/approve`;
const PAIRING_REQUEST_DENY_PATH = `${PAIRING_REQUESTS_PATH}/deny`;

/**
 * Guidance appended when the host rejects the mint. The routes themselves only
 * require loopback, but a scan can only complete when the public URL actually
 * fronts this assistant, the usual reason pairing doesn't work end to end.
 */
export const PAIRING_CONNECTIVITY_HINT =
  "If a scan can't connect, make sure a tunnel is running on the host (`vellum tunnel`) and the public URL points at it, then generate a new code.";

/** A pairing request that failed, carrying an optional actionable hint. */
export class PairDeviceError extends Error {
  readonly hint?: string;
  /** HTTP status of the rejecting response; unset for network failures. */
  readonly status?: number;

  constructor(message: string, hint?: string, status?: number) {
    super(message);
    this.name = "PairDeviceError";
    this.hint = hint;
    this.status = status;
  }
}

export interface DevicePairing {
  /** The scannable https pair URL (verification URI + `#device_code=…`). */
  pairUrl: string;
  /** ISO-8601 instant the pairing expires (single-use). */
  expiresAt: string;
}

/** What the "Pair a device" card needs about the assistant it pairs. */
export interface PairDeviceTarget {
  /** Absolute local-gateway base URL to mint the pairing challenge against. */
  base: string;
  /** The paired assistant's display name, or `null` when it has none. */
  assistantName: string | null;
  /**
   * The public https URL `vellum tunnel` recorded for this assistant, or `null`
   * when none is recorded — used to prefill the URL field.
   */
  ingressUrl: string | null;
}

/**
 * Resolve the selected assistant and its local-gateway base URL, or `null` when
 * device pairing isn't available from here. `getLocalGatewayUrl` already
 * resolves only in desktop/local mode (never remote-gateway or platform mode)
 * and only for an on-machine assistant with a recorded loopback gateway —
 * exactly the cases where a host-presence mint is possible — so a `null` here
 * doubles as the section's visibility gate.
 */
export function resolvePairDeviceTarget(): PairDeviceTarget | null {
  if (typeof window === "undefined") {
    return null;
  }
  const assistant = getSelectedAssistant();
  const path = getLocalGatewayUrl(assistant);
  if (!path) {
    return null;
  }
  return {
    base: `${window.location.origin}${path}`,
    assistantName: assistant?.name?.trim() || null,
    ingressUrl: assistant?.ingressUrl?.trim() || null,
  };
}

function serverErrorMessage(payload: unknown): string | null {
  const message = (payload as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

async function pairingRouteRequest<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  rejectionHint?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new PairDeviceError(
      "Couldn't reach the assistant. Make sure it's running and try again.",
    );
  }

  // A non-JSON body (e.g. an HTML error page) resolves to null and falls
  // through to the status / shape checks below.
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new PairDeviceError(
      serverErrorMessage(payload) ??
        `Pairing failed (HTTP ${response.status}).`,
      rejectionHint,
      response.status,
    );
  }

  if (payload === null || typeof payload !== "object") {
    throw new PairDeviceError("The assistant returned an unexpected response.");
  }
  return payload as T;
}

function postPairingRoute<T>(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  rejectionHint?: string,
): Promise<T> {
  return pairingRouteRequest<T>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
    rejectionHint,
  );
}

/**
 * Mint and auto-approve a device pairing against the host's loopback gateway,
 * returning the scannable pair URL and its expiry. Throws {@link PairDeviceError}
 * on rejection or an unreachable gateway; rethrows an `AbortError` when the
 * caller cancels.
 */
export async function mintDevicePairing(args: {
  base: string;
  publicBaseUrl: string;
  signal?: AbortSignal;
}): Promise<DevicePairing> {
  const { base, publicBaseUrl, signal } = args;

  const challenge = await postPairingRoute<RemoteWebPairingChallengeResponse>(
    `${base}${PAIRING_CHALLENGE_PATH}`,
    { publicBaseUrl } satisfies RemoteWebPairingChallengeRequest,
    signal,
    PAIRING_CONNECTIVITY_HINT,
  );

  await postPairingRoute(
    `${base}${PAIRING_VERIFICATION_PATH}`,
    {
      userCode: challenge.userCode,
    } satisfies RemoteWebPairingVerificationRequest,
    signal,
    PAIRING_CONNECTIVITY_HINT,
  );

  return {
    pairUrl: buildRemoteWebPairingUrl(challenge),
    expiresAt: challenge.expiresAt,
  };
}

/**
 * List the pending pairing requests awaiting host approval. Throws
 * {@link PairDeviceError} on rejection or an unreachable gateway; rethrows an
 * `AbortError` when the caller cancels.
 */
export async function listPendingPairingRequests(args: {
  base: string;
  signal?: AbortSignal;
}): Promise<RemoteWebPairingRequestSummary[]> {
  const payload =
    await pairingRouteRequest<RemoteWebPairingRequestListResponse>(
      `${args.base}${PAIRING_REQUESTS_PATH}`,
      { method: "GET" },
      args.signal,
    );
  return Array.isArray(payload.requests) ? payload.requests : [];
}

interface PairingRequestActionArgs {
  base: string;
  requestId: string;
  signal?: AbortSignal;
}

async function postPairingRequestAction(
  path: string,
  args: PairingRequestActionArgs,
): Promise<void> {
  await postPairingRoute(
    `${args.base}${path}`,
    {
      requestId: args.requestId,
    } satisfies RemoteWebPairingRequestActionRequest,
    args.signal,
  );
}

/**
 * Approve one pending pairing request by id. Throws {@link PairDeviceError} on
 * rejection (e.g. an unknown or expired request id) or an unreachable gateway;
 * rethrows an `AbortError` when the caller cancels.
 */
export function approvePairingRequest(
  args: PairingRequestActionArgs,
): Promise<void> {
  return postPairingRequestAction(PAIRING_REQUEST_APPROVE_PATH, args);
}

/**
 * Deny (delete) one pending pairing request by id. Throws
 * {@link PairDeviceError} on rejection or an unreachable gateway; rethrows an
 * `AbortError` when the caller cancels.
 */
export function denyPairingRequest(
  args: PairingRequestActionArgs,
): Promise<void> {
  return postPairingRequestAction(PAIRING_REQUEST_DENY_PATH, args);
}

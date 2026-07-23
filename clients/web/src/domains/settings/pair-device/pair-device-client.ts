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
 * Both routes are loopback-gated and unauthenticated (they refuse any
 * non-loopback origin server-side), so no token is attached — the loopback
 * proxy is the trust boundary. Minting is possible only from the host; a remote
 * paired session can never reach these routes, which is why the UI is hidden
 * outside local mode rather than relying on a client-side check.
 */

import type {
  RemoteWebPairingChallengeRequest,
  RemoteWebPairingChallengeResponse,
  RemoteWebPairingVerificationRequest,
} from "@vellumai/service-contracts/remote-web-pairing";

import { getLocalGatewayUrl, getSelectedAssistant } from "@/lib/local-mode";

import { buildRemoteWebPairingUrl } from "./pair-device-url";

const PAIRING_CHALLENGE_PATH = "/v1/remote-web/pairing-challenge";
const PAIRING_VERIFICATION_PATH = "/v1/remote-web/pairing-verification";

/**
 * Guidance appended when the host rejects the mint. The routes themselves only
 * require loopback, but a scan can only complete against the public URL when
 * remote web ingress is enabled on the host — the usual reason pairing doesn't
 * work end to end.
 */
export const WEB_REMOTE_INGRESS_HINT =
  "If a scan can't connect, enable remote web access on the host with `vellum flags set web-remote-ingress true`, then generate a new code.";

/** A pairing mint that failed, carrying an optional actionable hint. */
export class PairDeviceError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "PairDeviceError";
    this.hint = hint;
  }
}

export interface DevicePairing {
  /** The scannable https pair URL (verification URI + `#device_code=…`). */
  pairUrl: string;
  /** ISO-8601 instant the pairing expires (single-use). */
  expiresAt: string;
}

/**
 * The absolute local-gateway base URL to mint against, or `null` when device
 * pairing isn't available from here. `getLocalGatewayUrl` already resolves only
 * in desktop/local mode (never remote-gateway or platform mode) and only for an
 * on-machine assistant with a recorded loopback gateway — exactly the cases
 * where a host-presence mint is possible — so this doubles as the section's
 * visibility gate.
 */
export function resolvePairDeviceGatewayBase(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const path = getLocalGatewayUrl(getSelectedAssistant());
  if (!path) {
    return null;
  }
  return `${window.location.origin}${path}`;
}

function serverErrorMessage(payload: unknown): string | null {
  const message = (payload as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

async function postPairingRoute<T>(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
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
      WEB_REMOTE_INGRESS_HINT,
    );
  }

  if (payload === null || typeof payload !== "object") {
    throw new PairDeviceError("The assistant returned an unexpected response.");
  }
  return payload as T;
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
  );

  await postPairingRoute(
    `${base}${PAIRING_VERIFICATION_PATH}`,
    {
      userCode: challenge.userCode,
    } satisfies RemoteWebPairingVerificationRequest,
    signal,
  );

  return {
    pairUrl: buildRemoteWebPairingUrl(challenge),
    expiresAt: challenge.expiresAt,
  };
}

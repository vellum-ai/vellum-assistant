/**
 * Shared plumbing for dialing the GATEWAY's managed speech relay
 * (`/v1/speech/{stt,tts}/stream`): connection resolution, and mapping the
 * relay's error contract onto SttError categories.
 *
 * The daemon never dials velay itself — velay contact is gateway-only so
 * deterministic policy stays in a process the agent cannot rewrite. The
 * gateway route authenticates the daemon with a self-minted service JWT
 * (both processes share the HMAC signing key), attaches the Vellum
 * assistant API key on its own upstream leg to velay, and pipes Deepgram
 * wire frames verbatim. The gateway mirrors velay's error contract:
 * rejections are JSON `{code, detail}` bodies, and mid-session failures
 * are one `velay_error` text frame followed by an abnormal close.
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { CURRENT_POLICY_EPOCH } from "../../runtime/auth/policy.js";
import { mintToken } from "../../runtime/auth/token-service.js";
import type { SttErrorCategory } from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("vellum-speech-relay");

/**
 * The principal the gateway's speech-relay route accepts. Must match
 * DAEMON_SERVICE_SUB in gateway/src/http/routes/speech-relay-websocket.ts
 * — the packages don't share auth constants.
 */
const DAEMON_SERVICE_SUB = "svc:daemon:self";

/**
 * Per-dial token TTL. Deliberately short: the gateway validates at
 * upgrade time only, and every (re-)dial mints fresh — a session that
 * outlives its token (velay caps at 30 minutes) is fine, but a re-dial
 * must never reuse one.
 */
const RELAY_TOKEN_TTL_SECONDS = 300;

export interface SpeechRelayConnection {
  /** ws(s) origin of the gateway for the relay WebSocket dial. */
  wsBaseUrl: string;
  /** http(s) origin of the gateway for diagnostic (non-upgrade) probes. */
  httpBaseUrl: string;
  /**
   * Mint a fresh daemon service token for one dial. Called per
   * connection attempt so session-cap re-dials never present an expired
   * token.
   */
  mintServiceToken: () => string;
}

/**
 * Resolve everything needed to dial the gateway's speech relay, or null
 * when the daemon cannot mint a service token (signing key unavailable) —
 * the availability signal for the streaming resolver.
 */
export async function resolveSpeechRelayConnection(): Promise<SpeechRelayConnection | null> {
  const mintServiceToken = () =>
    mintToken({
      aud: "vellum-gateway",
      sub: DAEMON_SERVICE_SUB,
      scope_profile: "gateway_service_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: RELAY_TOKEN_TTL_SECONDS,
    });
  try {
    // Fail here, not mid-dial, when the signing key is unavailable.
    mintServiceToken();
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Managed speech relay unavailable: cannot mint a gateway service token",
    );
    return null;
  }
  const httpBaseUrl = getGatewayInternalBaseUrl().replace(/\/+$/, "");
  return {
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
    mintServiceToken,
  };
}

/** The relay's error contract: HTTP reject bodies and velay_error frames. */
export interface VelayErrorInfo {
  code: string;
  detail?: string;
}

/**
 * Map a relay error code onto an SttError category and a user-actionable
 * message. Codes are velay's contract plus the gateway route's own
 * (`missing_platform_connection`, `invalid_token`) — unknown codes degrade
 * to a provider error carrying the code for diagnosability.
 */
export function mapVelayError(error: VelayErrorInfo): {
  category: SttErrorCategory;
  message: string;
} {
  switch (error.code) {
    case "invalid_key":
    case "missing_platform_connection":
      return {
        category: "auth",
        message:
          "Managed speech needs a working Vellum platform connection — reconnect with 'assistant platform connect'.",
      };
    case "insufficient_balance":
      return {
        category: "provider-error",
        message:
          "Managed speech is paused: your Vellum organization is out of credits. Top up credits to continue.",
      };
    case "provider_unreachable":
    case "upstream_error":
      return {
        category: "provider-error",
        message: `Managed speech relay could not reach the speech provider (${error.code}).`,
      };
    default:
      return {
        category: "provider-error",
        message: `Managed speech relay error: ${error.code}${
          error.detail ? ` — ${error.detail}` : ""
        }`,
      };
  }
}

/**
 * Diagnose a failed WebSocket dial by replaying the request as a plain
 * HTTP GET. The gateway route runs its whole gate on non-upgrade requests
 * (token, stored credential, then velay's own gate via an upstream probe),
 * so a rejected upgrade reproduces as a JSON `{code, detail}` body; a
 * request that passes everything returns a 426 whose body is ignored here
 * (null → the original failure was transient/transport-level).
 *
 * The WebSocket API exposes no HTTP response details on a failed upgrade,
 * so this probe is the only way to distinguish "bad connection state"
 * from "gateway down".
 */
export async function probeVelayRejection(
  httpUrl: string,
): Promise<VelayErrorInfo | null> {
  try {
    const res = await fetch(httpUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok || res.status === 426) {
      return null;
    }
    const body = (await res.json()) as { code?: unknown; detail?: unknown };
    if (typeof body.code !== "string") {
      return null;
    }
    return {
      code: body.code,
      ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
    };
  } catch {
    return null;
  }
}

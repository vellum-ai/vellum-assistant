/**
 * Shared plumbing for dialing velay's managed speech relay
 * (`/v1/speech/{stt,tts}/stream`): connection resolution, and mapping the
 * relay's error contract onto SttError categories.
 *
 * The relay authenticates with the Vellum assistant API key (velay validates
 * it against the platform and meters usage server-side — adapters do nothing
 * for billing). Upgrade rejections are HTTP responses with a JSON
 * `{code, detail}` body; mid-session failures are one `velay_error` text
 * frame followed by an abnormal close.
 */

import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import type { SttErrorCategory } from "../../stt/types.js";

const DEFAULT_VELAY_BASE_URL = "https://velay.vellum.ai";

export interface VelaySpeechConnection {
  /** ws(s) origin for the relay WebSocket dial. */
  wsBaseUrl: string;
  /** http(s) origin for diagnostic (non-upgrade) requests. */
  httpBaseUrl: string;
  /** Vellum assistant API key — the relay's credential. */
  apiKey: string;
}

/**
 * Resolve everything needed to dial the velay speech relay, or null when
 * the platform connection is missing — the availability signal for
 * resolvers and preflight.
 */
export async function resolveVelaySpeechConnection(): Promise<VelaySpeechConnection | null> {
  const apiKey = await getSecureKeyAsync(
    credentialKey("vellum", "assistant_api_key"),
  );
  if (!apiKey) {
    return null;
  }
  const httpBaseUrl = (
    process.env.VELAY_BASE_URL?.trim() || DEFAULT_VELAY_BASE_URL
  ).replace(/\/+$/, "");
  const wsBaseUrl = httpBaseUrl.replace(/^http/, "ws");
  return { wsBaseUrl, httpBaseUrl, apiKey };
}

/** The relay's error contract: HTTP reject bodies and velay_error frames. */
export interface VelayErrorInfo {
  code: string;
  detail?: string;
}

/**
 * Map a relay error code onto an SttError category and a user-actionable
 * message. Codes are the relay contract's — unknown codes degrade to a
 * provider error carrying the code for diagnosability.
 */
export function mapVelayError(error: VelayErrorInfo): {
  category: SttErrorCategory;
  message: string;
} {
  switch (error.code) {
    case "invalid_key":
      return {
        category: "auth",
        message:
          "Vellum rejected the assistant API key for managed speech — reconnect with 'assistant platform connect'.",
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
 * HTTPS GET. Velay runs its whole gate (auth, params, balance, upstream
 * dial) before upgrading, so a rejected upgrade reproduces as a JSON
 * `{code, detail}` body; a request that passes the gate fails only at the
 * upgrade step, which returns no such body — that means the original
 * failure was transient/transport-level, and null is returned.
 *
 * The WebSocket API exposes no HTTP response details on a failed upgrade,
 * so this probe is the only way to distinguish "bad key" from "velay down".
 */
export async function probeVelayRejection(
  httpUrl: string,
): Promise<VelayErrorInfo | null> {
  try {
    const res = await fetch(httpUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
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

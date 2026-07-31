import {
  authHeaders,
  getPlatformUrl,
  invalidateOrgIdCache,
  isPlatformApiKey,
} from "../platform-client.js";
import { loopbackSafeFetch } from "../loopback-fetch.js";

const TOKEN_MINT_TIMEOUT_MS = 10_000;
const AUTHENTICATION_ERROR_MESSAGE =
  "Live-voice authentication failed. Run 'vellum login' to refresh.";

export interface LiveVoiceToken {
  token: string;
  expiresAt: string;
}

export type LiveVoiceTokenMintErrorCode =
  | "api_key_unsupported"
  | "authentication_failed"
  | "request_failed"
  | "malformed_response";

export class LiveVoiceTokenMintError extends Error {
  readonly code: LiveVoiceTokenMintErrorCode;
  readonly status: number | undefined;

  constructor(
    code: LiveVoiceTokenMintErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "LiveVoiceTokenMintError";
    this.code = code;
    this.status = status;
  }
}

function isLiveVoiceToken(value: unknown): value is LiveVoiceToken {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const expiresAt =
    typeof candidate.expiresAt === "string"
      ? Date.parse(candidate.expiresAt)
      : Number.NaN;
  return (
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    !/\s/.test(candidate.token) &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now()
  );
}

async function requestLiveVoiceToken(
  sessionToken: string,
  assistantId: string,
  platformUrl: string | undefined,
): Promise<Response> {
  let headers: Record<string, string>;
  try {
    headers = await authHeaders(sessionToken, platformUrl);
  } catch {
    throw new LiveVoiceTokenMintError(
      "authentication_failed",
      AUTHENTICATION_ERROR_MESSAGE,
    );
  }

  const resolvedUrl = platformUrl || getPlatformUrl();
  try {
    return await loopbackSafeFetch(`${resolvedUrl}/v1/auth/live-voice-token/`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assistantId }),
      signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
    });
  } catch {
    throw new LiveVoiceTokenMintError(
      "request_failed",
      "The live-voice token request could not reach the Vellum platform.",
    );
  }
}

/**
 * Mint an assistant-scoped, short-lived token for a managed live-voice
 * WebSocket. The endpoint accepts user sessions and deliberately rejects
 * platform API keys.
 */
export async function mintLiveVoiceToken(
  sessionToken: string,
  assistantId: string,
  platformUrl?: string,
): Promise<LiveVoiceToken> {
  if (isPlatformApiKey(sessionToken)) {
    throw new LiveVoiceTokenMintError(
      "api_key_unsupported",
      "Live voice for a managed assistant requires a Vellum user session. Run 'vellum login'.",
    );
  }

  let response = await requestLiveVoiceToken(
    sessionToken,
    assistantId,
    platformUrl,
  );
  if (response.status === 401) {
    invalidateOrgIdCache(sessionToken, platformUrl);
    response = await requestLiveVoiceToken(
      sessionToken,
      assistantId,
      platformUrl,
    );
  }

  if (!response.ok) {
    const authenticationFailure =
      response.status === 401 || response.status === 403;
    throw new LiveVoiceTokenMintError(
      authenticationFailure ? "authentication_failed" : "request_failed",
      authenticationFailure
        ? AUTHENTICATION_ERROR_MESSAGE
        : `The Vellum platform could not mint a live-voice token (HTTP ${response.status}).`,
      response.status,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (!isLiveVoiceToken(body)) {
    throw new LiveVoiceTokenMintError(
      "malformed_response",
      "The Vellum platform returned a malformed live-voice token response.",
    );
  }
  return body;
}

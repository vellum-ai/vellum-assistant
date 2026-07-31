import { lookupAssistantByIdentifier } from "./assistant-config.js";
import {
  guardianTokenDueForRenewal,
  loadGuardianToken,
  refreshGuardianToken,
} from "./guardian-token.js";
import { trustedRefreshUrl } from "./runtime-url.js";

export type GuardianSessionAuthErrorCode =
  | "untrusted_refresh_destination"
  | "refresh_failed";

export class GuardianSessionAuthError extends Error {
  readonly code: GuardianSessionAuthErrorCode;

  constructor(code: GuardianSessionAuthErrorCode, message: string) {
    super(message);
    this.name = "GuardianSessionAuthError";
    this.code = code;
  }
}

export type GuardianSessionAuthResult =
  | {
      ok: true;
      accessToken: string | undefined;
      refreshed: boolean;
    }
  | {
      ok: false;
      accessToken: string;
      error: GuardianSessionAuthError;
    };

export interface ResolveGuardianSessionAuthOptions {
  runtimeUrl: string;
  assistantId: string;
  accessToken: string | undefined;
  cloud: string | undefined;
}

export function loadGuardianSessionAccessToken(
  assistantId: string,
): string | undefined {
  return loadGuardianToken(assistantId)?.accessToken;
}

/**
 * Resolve the guardian access token for a command session and refresh a stored
 * token when it is due. Ephemeral token overrides and platform sessions never
 * use stored refresh credentials.
 */
export async function resolveGuardianSessionAuth({
  runtimeUrl,
  assistantId,
  accessToken,
  cloud,
}: ResolveGuardianSessionAuthOptions): Promise<GuardianSessionAuthResult> {
  if (cloud === "vellum" || !accessToken || !assistantId) {
    return { ok: true, accessToken, refreshed: false };
  }

  const stored = loadGuardianToken(assistantId);
  if (
    !stored ||
    stored.accessToken !== accessToken ||
    !stored.refreshToken ||
    !guardianTokenDueForRenewal(stored)
  ) {
    return { ok: true, accessToken, refreshed: false };
  }

  const lookup = lookupAssistantByIdentifier(assistantId);
  if (lookup.status !== "found") {
    return {
      ok: false,
      accessToken,
      error: new GuardianSessionAuthError(
        "untrusted_refresh_destination",
        "The stored guardian session has no trusted assistant destination.",
      ),
    };
  }

  const refreshUrl = trustedRefreshUrl(lookup.entry, runtimeUrl);
  if (!refreshUrl) {
    return {
      ok: false,
      accessToken,
      error: new GuardianSessionAuthError(
        "untrusted_refresh_destination",
        "The guardian session cannot be refreshed through an explicit untrusted URL.",
      ),
    };
  }

  const refreshed = await refreshGuardianToken(refreshUrl, assistantId);
  if (!refreshed?.accessToken) {
    return {
      ok: false,
      accessToken,
      error: new GuardianSessionAuthError(
        "refresh_failed",
        "The guardian session could not be refreshed.",
      ),
    };
  }

  return { ok: true, accessToken: refreshed.accessToken, refreshed: true };
}

/**
 * Compatibility helper for commands that intentionally continue with the
 * current access token when proactive refresh is unavailable.
 */
export async function resolveFreshBearerToken(
  runtimeUrl: string,
  assistantId: string,
  bearerToken: string | undefined,
  cloud: string | undefined,
): Promise<string | undefined> {
  const result = await resolveGuardianSessionAuth({
    runtimeUrl,
    assistantId,
    accessToken: bearerToken,
    cloud,
  });
  return result.accessToken;
}

import {
  isLocalMode,
  getLocalGatewayUrl,
} from "@/lib/local-mode";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

/**
 * Thrown when the gateway `/auth/token` mint rejects the request, carrying the
 * response `status` so callers can branch on the failure class. A `401` means
 * the gateway refused the guardian token itself — most often an
 * `invalid_signature` after the gateway restarted with a different signing key
 * than the on-disk guardian token was leased against — which a guardian
 * re-provision (`wake --repair-guardian`) fixes by re-leasing against the
 * running gateway. A `403` is a loopback/Origin boundary refusal that repair
 * can't change, and `5xx`/network failures are transient.
 *
 * Distinct from {@link GuardianTokenError} (thrown by `fetchGuardianTokenHost`
 * when the guardian token is missing/unrefreshable on disk): this is the
 * downstream mint rejecting a token that read back fine.
 */
export class GatewayTokenError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GatewayTokenError";
    this.status = status;
  }
}

/**
 * True when a connect failure is the gateway rejecting the guardian token at
 * the `/auth/token` mint (a `401`), which a guardian re-provision can recover.
 * `403` (boundary refusal) and `5xx`/network failures are not re-provisionable.
 */
export function isRepairableGatewayTokenError(error: unknown): boolean {
  return error instanceof GatewayTokenError && error.status === 401;
}

const LS_TOKEN_KEY = "vellum:gw:token";
const LS_EXPIRES_KEY = "vellum:gw:expiresAt";
const LS_TOKEN_SOURCE_KEY = "vellum:gw:tokenSource";

// Legacy key names kept as read fallbacks in case the startup migration
// in storage-migration.ts failed (e.g. QuotaExceededError on setItem).
const LEGACY_TOKEN_KEY = "gw:token";
const LEGACY_EXPIRES_KEY = "gw:expiresAt";
const LEGACY_TOKEN_SOURCE_KEY = "gw:tokenSource";

let cachedToken: string | null = null;
let cachedExpiresAt: number = 0;
let cachedTokenSource: string | null = null;

export function isGatewayAuthEnabled(): boolean {
  return isLocalMode() && getLocalGatewayUrl() != null;
}

export function isGatewayAuthMode(): boolean {
  return isGatewayAuthEnabled() && getGatewayToken() !== null;
}

function isTokenExpired(expiresAt: number): boolean {
  return Date.now() / 1000 >= expiresAt - 60;
}

export function getGatewayToken(): string | null {
  if (cachedToken && !isTokenExpired(cachedExpiresAt)) {
    return cachedToken;
  }
  cachedToken = null;
  try {
    const token =
      localStorage.getItem(LS_TOKEN_KEY) ??
      localStorage.getItem(LEGACY_TOKEN_KEY);
    const expiresAtRaw =
      localStorage.getItem(LS_EXPIRES_KEY) ??
      localStorage.getItem(LEGACY_EXPIRES_KEY);
    if (token && expiresAtRaw) {
      const expiresAt = Number(expiresAtRaw);
      if (!isTokenExpired(expiresAt)) {
        cachedToken = token;
        cachedExpiresAt = expiresAt;
        return cachedToken;
      }
    }
  } catch {
    // localStorage unavailable
  }
  return null;
}

async function acquireGatewayToken(tokenUrl?: string, guardianToken?: string): Promise<string> {
  const url = tokenUrl ?? "/auth/token";
  const headers: Record<string, string> = {};
  if (guardianToken) {
    headers["Authorization"] = `Bearer ${guardianToken}`;
  }
  const res = await fetch(url, { method: "POST", headers });
  if (!res.ok) {
    throw new GatewayTokenError(
      res.status,
      `Gateway token request failed: ${res.status}`,
    );
  }
  const { token, expiresAt } = (await res.json()) as {
    token: string;
    expiresAt: number;
  };
  try {
    localStorage.setItem(LS_TOKEN_KEY, token);
    localStorage.setItem(LS_EXPIRES_KEY, String(expiresAt));
    localStorage.setItem(LS_TOKEN_SOURCE_KEY, url);
  } catch {
    // localStorage unavailable
  }
  cachedToken = token;
  cachedExpiresAt = expiresAt;
  cachedTokenSource = url;
  return token;
}

export async function ensureGatewayToken(tokenUrl?: string, guardianToken?: string): Promise<string> {
  const source = tokenUrl ?? "/auth/token";
  const storedSource =
    cachedTokenSource ??
    localStorage.getItem(LS_TOKEN_SOURCE_KEY) ??
    localStorage.getItem(LEGACY_TOKEN_SOURCE_KEY);
  if (storedSource && storedSource !== source) {
    clearGatewayToken();
  }
  const existing = getGatewayToken();
  if (existing) return existing;
  return acquireGatewayToken(tokenUrl, guardianToken);
}

export function getLocalTokenUrl(
  assistant?: LockfileAssistant,
): string | undefined {
  const gatewayUrl = getLocalGatewayUrl(assistant);
  if (!gatewayUrl) return undefined;
  return `${gatewayUrl}/auth/token`;
}

export function clearGatewayToken(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  cachedTokenSource = null;
  try {
    localStorage.removeItem(LS_TOKEN_KEY);
    localStorage.removeItem(LS_EXPIRES_KEY);
    localStorage.removeItem(LS_TOKEN_SOURCE_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_EXPIRES_KEY);
    localStorage.removeItem(LEGACY_TOKEN_SOURCE_KEY);
  } catch {
    // localStorage unavailable
  }
}

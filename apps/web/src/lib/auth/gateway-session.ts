import {
  isLocalMode,
  getLocalGatewayUrl,
} from "@/lib/local-mode";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

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
    throw new Error(`Gateway token request failed: ${res.status}`);
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

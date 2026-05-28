import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store";
import {
  isLocalMode,
  getLocalGatewayUrl,
} from "@/lib/local-mode";

const LS_TOKEN_KEY = "gw:token";
const LS_EXPIRES_KEY = "gw:expiresAt";
const LS_TOKEN_SOURCE_KEY = "gw:tokenSource";

let cachedToken: string | null = null;
let cachedExpiresAt: number = 0;
let cachedTokenSource: string | null = null;

export function isGatewayAuthEnabled(): boolean {
  if (isLocalMode()) {
    return getLocalGatewayUrl() != null;
  }
  return useClientFeatureFlagStore.getState().gatewayWebAuth === true;
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
    const token = localStorage.getItem(LS_TOKEN_KEY);
    const expiresAtRaw = localStorage.getItem(LS_EXPIRES_KEY);
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
  const storedSource = cachedTokenSource ?? localStorage.getItem(LS_TOKEN_SOURCE_KEY);
  if (storedSource && storedSource !== source) {
    clearGatewayToken();
  }
  const existing = getGatewayToken();
  if (existing) return existing;
  return acquireGatewayToken(tokenUrl, guardianToken);
}

export function getLocalTokenUrl(): string | undefined {
  const gatewayUrl = getLocalGatewayUrl();
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
  } catch {
    // localStorage unavailable
  }
}

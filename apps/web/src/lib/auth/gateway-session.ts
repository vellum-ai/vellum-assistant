import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store";

const LS_TOKEN_KEY = "gw:token";
const LS_EXPIRES_KEY = "gw:expiresAt";

let cachedToken: string | null = null;
let cachedExpiresAt: number = 0;

export function isGatewayAuthEnabled(): boolean {
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

async function acquireGatewayToken(): Promise<string> {
  const res = await fetch("/auth/token", { method: "POST" });
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
  } catch {
    // localStorage unavailable
  }
  cachedToken = token;
  cachedExpiresAt = expiresAt;
  return token;
}

export async function ensureGatewayToken(): Promise<string> {
  const existing = getGatewayToken();
  if (existing) return existing;
  return acquireGatewayToken();
}

export function clearGatewayToken(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  try {
    localStorage.removeItem(LS_TOKEN_KEY);
    localStorage.removeItem(LS_EXPIRES_KEY);
  } catch {
    // localStorage unavailable
  }
}

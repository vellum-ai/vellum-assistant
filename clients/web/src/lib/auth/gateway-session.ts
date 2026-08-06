import {
  isLocalClient,
  getLocalGatewayUrl,
  getPairedGatewayUrl,
  getSelectedAssistant,
  isRemoteGatewayMode,
} from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

/**
 * Thrown when the gateway `/auth/token` mint rejects the request, carrying the
 * response `status` so callers can branch on the failure class. A `401` means
 * the gateway refused to mint against the presented guardian identity — most
 * often an `invalid_signature` after the gateway restarted with a different
 * signing key than the on-disk guardian token was leased against, or a
 * `guardian_repair_required` refusal after the gateway DB lost its guardian
 * rows — which a guardian re-provision (`wake --repair-guardian`) fixes by
 * re-leasing against the running gateway. A `403` is a loopback/Origin
 * boundary refusal that repair can't change, and `5xx`/network failures are
 * transient.
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
let remoteGatewayToken: string | null = null;
let remoteGatewayExpiresAt: number = 0;

export function isGatewayAuthEnabled(): boolean {
  if (isRemoteGatewayMode()) {
    return true;
  }
  if (!isLocalClient()) {
    return false;
  }
  return (
    getLocalGatewayUrl() != null ||
    getPairedGatewayUrl(getSelectedAssistant()) != null
  );
}

export function isGatewayAuthMode(): boolean {
  if (!isGatewayAuthEnabled()) {
    return false;
  }
  if (!isRemoteGatewayMode()) {
    const selectedAssistant = getSelectedAssistant();
    const pairedGatewayUrl = getPairedGatewayUrl(selectedAssistant);
    if (pairedGatewayUrl != null) {
      return (
        getSelfHostedIngressUrl() ===
        `${window.location.origin}${pairedGatewayUrl}`
      );
    }
  }
  return getGatewayToken() !== null;
}

function isTokenExpired(expiresAt: number): boolean {
  return Date.now() / 1000 >= expiresAt - 60;
}

function toEpochSeconds(value: string | number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
  }
  return value > 1_000_000_000_000 ? value / 1000 : value;
}

export function setRemoteGatewayToken(params: {
  accessToken: string;
  accessTokenExpiresAt: string | number;
}): void {
  remoteGatewayToken = params.accessToken;
  remoteGatewayExpiresAt = toEpochSeconds(params.accessTokenExpiresAt);
}

export function getGatewayToken(): string | null {
  if (isRemoteGatewayMode()) {
    if (remoteGatewayToken && !isTokenExpired(remoteGatewayExpiresAt)) {
      return remoteGatewayToken;
    }
    remoteGatewayToken = null;
    remoteGatewayExpiresAt = 0;
    return null;
  }

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

/**
 * Install a gateway-minted actor bearer in the in-memory and localStorage
 * slots used by `getGatewayToken()`. Paired guardian credentials never enter
 * this module; their trusted host proxy owns acquisition and injection.
 */
export function seedGatewayToken(params: {
  token: string;
  expiresAtEpochSeconds: number;
  source: string;
}): void {
  try {
    localStorage.setItem(LS_TOKEN_KEY, params.token);
    localStorage.setItem(LS_EXPIRES_KEY, String(params.expiresAtEpochSeconds));
    localStorage.setItem(LS_TOKEN_SOURCE_KEY, params.source);
  } catch {
    // localStorage unavailable
  }
  cachedToken = params.token;
  cachedExpiresAt = params.expiresAtEpochSeconds;
  cachedTokenSource = params.source;
}

async function acquireGatewayToken(
  tokenUrl?: string,
  guardianToken?: string,
): Promise<string> {
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
  seedGatewayToken({ token, expiresAtEpochSeconds: expiresAt, source: url });
  return token;
}

export async function ensureGatewayToken(
  tokenUrl?: string,
  guardianToken?: string,
): Promise<string> {
  const source = tokenUrl ?? "/auth/token";
  const storedSource =
    cachedTokenSource ??
    localStorage.getItem(LS_TOKEN_SOURCE_KEY) ??
    localStorage.getItem(LEGACY_TOKEN_SOURCE_KEY);
  if (storedSource && storedSource !== source) {
    clearGatewayToken();
  }
  const existing = getGatewayToken();
  if (existing) {
    return existing;
  }
  return acquireGatewayToken(tokenUrl, guardianToken);
}

export function getLocalTokenUrl(
  assistant?: LockfileAssistant,
): string | undefined {
  const gatewayUrl = getLocalGatewayUrl(assistant);
  if (!gatewayUrl) {
    return undefined;
  }
  return `${gatewayUrl}/auth/token`;
}

export function clearGatewayToken(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  cachedTokenSource = null;
  remoteGatewayToken = null;
  remoteGatewayExpiresAt = 0;
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

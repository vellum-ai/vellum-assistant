import {
  getGatewayToken,
  setRemoteGatewayToken,
} from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

const PAIRING_TOKEN_PATH = "/v1/remote-web/pairing-token";
const PAIRING_CHALLENGE_PATH = "/v1/remote-web/pairing-challenge";
const GUARDIAN_REFRESH_PATH = "/v1/guardian/refresh";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REFRESH_EARLY_MS = 5_000;
const REFRESH_LOCK_KEY = "vellum:remote-gateway:refresh-lock";
const REFRESH_LOCK_NAME = "vellum-remote-gateway-refresh";
const REFRESH_LOCK_TTL_MS = 20_000;
const REFRESH_LOCK_WAIT_MS = 20_000;
const REFRESH_LOCK_POLL_MS = 100;

type BrowserLocks = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type RefreshLockRecord = {
  owner: string;
  expiresAt: number;
};

let remoteGatewayRefreshAfterMs = 0;
let refreshRemoteGatewaySessionPromise: Promise<boolean> | null = null;

export interface RemoteWebPairingParams {
  deviceCode: string | null;
  userCode: string | null;
}

export interface RemoteWebPairingChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface RemoteWebPairingPending {
  status: "pending";
  expiresAt: string;
  intervalSeconds: number;
}

export interface RemoteWebPairingApproved {
  status: "approved";
  accessToken: string;
  accessTokenExpiresAt: string | number;
  refreshAfter: string | number;
  guardianId?: string;
  assistantId?: string;
}

export type RemoteWebPairingTokenResult =
  | RemoteWebPairingPending
  | RemoteWebPairingApproved;

export class RemoteWebPairingError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "RemoteWebPairingError";
    this.status = status;
    this.code = code;
  }
}

function errorBodyCode(body: unknown): string | null {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : null;
}

function stringParam(
  params: URLSearchParams,
  ...names: string[]
): string | null {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function paramsFromUrl(url: URL): URLSearchParams {
  const merged = new URLSearchParams(url.search);
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    for (const [key, value] of hashParams) {
      if (!merged.has(key)) merged.set(key, value);
    }
  }
  return merged;
}

export function parseRemoteWebPairingParams(
  value: string | URL,
): RemoteWebPairingParams {
  const url =
    typeof value === "string" ? new URL(value, window.location.origin) : value;
  const params = paramsFromUrl(url);
  return {
    deviceCode: stringParam(params, "deviceCode", "device_code"),
    userCode: stringParam(params, "userCode", "user_code"),
  };
}

export function remoteGatewayPublicPathPrefix(
  location = window.location,
): string {
  const match = /\/assistant(?:\/|$)/.exec(location.pathname);
  return match && match.index > 0
    ? location.pathname.slice(0, match.index).replace(/\/+$/, "")
    : "";
}

export function remoteGatewayApiPath(
  path: string,
  location = window.location,
): string {
  return `${remoteGatewayPublicPathPrefix(location)}${path}`;
}

function remoteGatewayPublicBaseUrl(): string {
  return `${window.location.origin}${remoteGatewayPublicPathPrefix()}`;
}

function toEpochMilliseconds(value: string | number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function shouldRefreshRemoteGatewaySession(): boolean {
  if (!getGatewayToken()) return true;
  if (remoteGatewayRefreshAfterMs <= 0) return true;
  return Date.now() >= remoteGatewayRefreshAfterMs - REFRESH_EARLY_MS;
}

function isApprovedPayload(value: unknown): value is RemoteWebPairingApproved {
  const payload = value as Partial<RemoteWebPairingApproved>;
  return (
    payload?.status === "approved" &&
    typeof payload.accessToken === "string" &&
    (typeof payload.accessTokenExpiresAt === "string" ||
      typeof payload.accessTokenExpiresAt === "number") &&
    (typeof payload.refreshAfter === "string" ||
      typeof payload.refreshAfter === "number")
  );
}

function isChallengePayload(
  value: unknown,
): value is RemoteWebPairingChallenge {
  const payload = value as Partial<RemoteWebPairingChallenge>;
  return (
    typeof payload?.deviceCode === "string" &&
    typeof payload.userCode === "string" &&
    typeof payload.verificationUri === "string" &&
    typeof payload.expiresAt === "string" &&
    typeof payload.expiresInSeconds === "number" &&
    typeof payload.intervalSeconds === "number"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRefreshLock(): RefreshLockRecord | null {
  try {
    const raw = localStorage.getItem(REFRESH_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RefreshLockRecord>;
    if (
      typeof parsed.owner !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return { owner: parsed.owner, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function tryAcquireRefreshLock(owner: string): boolean {
  try {
    const current = readRefreshLock();
    if (current && current.expiresAt > Date.now()) return false;
    localStorage.setItem(
      REFRESH_LOCK_KEY,
      JSON.stringify({ owner, expiresAt: Date.now() + REFRESH_LOCK_TTL_MS }),
    );
    return readRefreshLock()?.owner === owner;
  } catch {
    return true;
  }
}

function releaseRefreshLock(owner: string): void {
  try {
    if (readRefreshLock()?.owner === owner) {
      localStorage.removeItem(REFRESH_LOCK_KEY);
    }
  } catch {
    // localStorage unavailable
  }
}

async function withLocalStorageRefreshLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const owner = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const waitUntil = Date.now() + REFRESH_LOCK_WAIT_MS;

  while (!tryAcquireRefreshLock(owner)) {
    if (Date.now() >= waitUntil) return fn();
    await sleep(REFRESH_LOCK_POLL_MS);
  }

  try {
    return await fn();
  } finally {
    releaseRefreshLock(owner);
  }
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  // Refresh tokens are single-use; serialize cookie refresh so multiple tabs
  // do not replay the same cookie before the first Set-Cookie lands.
  const locks =
    typeof navigator !== "undefined"
      ? ((navigator as Navigator & { locks?: BrowserLocks }).locks ?? null)
      : null;
  if (locks) return locks.request(REFRESH_LOCK_NAME, fn);
  return withLocalStorageRefreshLock(fn);
}

export function activateRemoteGatewaySession(
  session: RemoteWebPairingApproved,
): void {
  remoteGatewayRefreshAfterMs = toEpochMilliseconds(session.refreshAfter);
  setRemoteGatewayToken({
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
  });
  setSelfHostedConnection({
    url: `${window.location.origin}${remoteGatewayPublicPathPrefix()}`,
    token: session.accessToken,
  });
}

export async function exchangeRemoteWebPairingToken(
  deviceCode: string,
  signal?: AbortSignal,
): Promise<RemoteWebPairingTokenResult> {
  const response = await fetch(remoteGatewayApiPath(PAIRING_TOKEN_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
    signal,
  });
  // A non-JSON body (e.g. an HTML error page) resolves to null and falls
  // through to the status / shape checks below.
  const body = (await response.json().catch(() => null)) as unknown;

  if (response.status === 202) {
    const pending = (body ?? {}) as Partial<RemoteWebPairingPending>;
    return {
      status: "pending",
      expiresAt: typeof pending.expiresAt === "string" ? pending.expiresAt : "",
      intervalSeconds:
        typeof pending.intervalSeconds === "number" &&
        pending.intervalSeconds > 0
          ? pending.intervalSeconds
          : DEFAULT_POLL_INTERVAL_SECONDS,
    };
  }

  if (!response.ok) {
    throw new RemoteWebPairingError(
      response.status,
      `Pairing token exchange failed: ${response.status}`,
      errorBodyCode(body),
    );
  }

  if (!isApprovedPayload(body)) {
    throw new RemoteWebPairingError(
      502,
      "Pairing token exchange returned an invalid response",
    );
  }

  return body;
}

export async function createRemoteWebPairingChallenge(
  signal?: AbortSignal,
): Promise<RemoteWebPairingChallenge> {
  const response = await fetch(remoteGatewayApiPath(PAIRING_CHALLENGE_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicBaseUrl: remoteGatewayPublicBaseUrl() }),
    signal,
  });
  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new RemoteWebPairingError(
      response.status,
      `Pairing challenge creation failed: ${response.status}`,
    );
  }

  if (!isChallengePayload(body)) {
    throw new RemoteWebPairingError(
      502,
      "Pairing challenge creation returned an invalid response",
    );
  }

  return body;
}

async function refreshRemoteGatewaySessionOnce(): Promise<boolean> {
  if (!shouldRefreshRemoteGatewaySession()) return true;

  const response = await fetch(remoteGatewayApiPath(GUARDIAN_REFRESH_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isApprovedPayload({ ...(body as object), status: "approved" })) {
    return false;
  }
  activateRemoteGatewaySession({
    ...(body as Omit<RemoteWebPairingApproved, "status">),
    status: "approved",
  });
  return true;
}

export async function refreshRemoteGatewaySession(): Promise<boolean> {
  if (!shouldRefreshRemoteGatewaySession()) return true;

  refreshRemoteGatewaySessionPromise ??= withRefreshLock(
    refreshRemoteGatewaySessionOnce,
  ).finally(() => {
    refreshRemoteGatewaySessionPromise = null;
  });
  return refreshRemoteGatewaySessionPromise;
}

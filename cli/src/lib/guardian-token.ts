import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { platform } from "os";
import { dirname, join } from "path";

import { SEEDS } from "@vellumai/environments";
import {
  guardianTokenPath,
  resolveConfigDir,
} from "@vellumai/local-mode";

import { getConfigDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";

const DEVICE_ID_SALT = "vellum-assistant-host-id";

export interface GuardianTokenData {
  guardianPrincipalId: string;
  accessToken: string;
  /** ISO date string or epoch-ms number as returned by the gateway. */
  accessTokenExpiresAt: string | number;
  refreshToken: string;
  /** ISO date string or epoch-ms number as returned by the gateway. */
  refreshTokenExpiresAt: string | number;
  refreshAfter: string;
  isNew: boolean;
  deviceId: string;
  leasedAt: string;
}

function getGuardianTokenPath(assistantId: string): string {
  // Resolve via the shared @vellumai/local-mode resolver — the same one every
  // host-seam reader (`getGuardianAccessToken`) uses — so the token is always
  // written where it's read. Must stay in lockstep with `getConfigDir(
  // getCurrentEnvironment())`; the parity test in guardian-token.test.ts guards
  // against drift.
  return guardianTokenPath(resolveConfigDir(process.env), assistantId);
}

/**
 * Best-effort removal of an assistant's stored guardian token (used by
 * `vellum unpair` to forget a paired connection). Never throws if the token
 * file or its per-assistant directory is already absent.
 */
export function deleteGuardianToken(assistantId: string): void {
  const tokenPath = getGuardianTokenPath(assistantId);
  try {
    unlinkSync(tokenPath);
  } catch {
    /* already gone */
  }
  // Clean up the now-empty per-assistant directory; rmdir throws if it still
  // holds other files, in which case we leave it.
  try {
    rmdirSync(dirname(tokenPath));
  } catch {
    /* not empty or absent */
  }
}

function getPersistedDeviceIdPath(): string {
  return join(getConfigDir(getCurrentEnvironment()), "device-id");
}

function hashWithSalt(input: string): string {
  return createHash("sha256")
    .update(input + DEVICE_ID_SALT)
    .digest("hex");
}

function getMacOSPlatformUUID(): string | null {
  try {
    const output = execSync(
      "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/{print $3}'",
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const uuid = output.replace(/"/g, "");
    return uuid.length > 0 ? uuid : null;
  } catch {
    return null;
  }
}

function getLinuxMachineId(): string | null {
  try {
    return readFileSync("/etc/machine-id", "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function getWindowsMachineGuid(): string | null {
  try {
    const output = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function getOrCreatePersistedDeviceId(): string {
  const path = getPersistedDeviceIdPath();
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // File doesn't exist yet
  }
  const newId = randomUUID();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, newId + "\n", { mode: 0o600 });
  return newId;
}

/**
 * Compute a stable device identifier matching the native client conventions.
 *
 * - macOS: SHA-256 of IOPlatformUUID + salt
 * - Linux: SHA-256 of /etc/machine-id + salt
 * - Windows: SHA-256 of HKLM MachineGuid + salt
 * - Fallback: persisted random UUID in XDG config
 */
export function computeDeviceId(): string {
  const os = platform();

  if (os === "darwin") {
    const uuid = getMacOSPlatformUUID();
    if (uuid) return hashWithSalt(uuid);
  } else if (os === "linux") {
    const machineId = getLinuxMachineId();
    if (machineId) return hashWithSalt(machineId);
  } else if (os === "win32") {
    const guid = getWindowsMachineGuid();
    if (guid) return hashWithSalt(guid);
  }

  return getOrCreatePersistedDeviceId();
}

/**
 * Read a previously persisted guardian token for the given assistant.
 * Returns the parsed token data, or null if the file does not exist or is
 * unreadable.
 */
export function loadGuardianToken(
  assistantId: string,
): GuardianTokenData | null {
  const tokenPath = getGuardianTokenPath(assistantId);
  try {
    const raw = readFileSync(tokenPath, "utf-8");
    return JSON.parse(raw) as GuardianTokenData;
  } catch {
    return null;
  }
}

export function saveGuardianToken(
  assistantId: string,
  data: GuardianTokenData,
): void {
  const tokenPath = getGuardianTokenPath(assistantId);
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(tokenPath, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(tokenPath, 0o600);
}

/** Abort the refresh POST if the gateway is slow/unreachable (it's now on the
 *  hot request path, so it must never hang indefinitely). */
const REFRESH_FETCH_TIMEOUT_MS = 15_000;
/** Max time to wait for the per-assistant refresh lock before proceeding. */
const REFRESH_LOCK_WAIT_MS = 10_000;
/** A lock older than this is treated as stale (holder crashed) and stolen. */
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_POLL_MS = 100;

function getRefreshLockPath(assistantId: string): string {
  return join(dirname(getGuardianTokenPath(assistantId)), "refresh.lock");
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort exclusive cross-process lock for a per-assistant token refresh.
 * Created atomically with `wx`; a stale lock (crashed holder) is stolen.
 * Returns true if acquired, false if it timed out (caller proceeds degraded).
 */
async function acquireRefreshLock(lockPath: string): Promise<boolean> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS) {
          unlinkSync(lockPath); // steal a stale lock, then retry
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() >= deadline) return false;
      await delay(REFRESH_LOCK_POLL_MS);
    }
  }
}

function releaseRefreshLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already released/stolen */
  }
}

/**
 * Call POST /v1/guardian/refresh on the remote gateway to obtain a new
 * access token using an existing (possibly expired) access token for auth.
 * Returns the refreshed token data (persisted locally), or null if the
 * refresh fails (e.g. no stored token, or refresh token itself is expired).
 *
 * Concurrency-safe: the gateway rotates refresh tokens and treats reuse of an
 * already-rotated token as replay (revoking the whole token family), so two
 * processes (e.g. `vellum message` + `vellum events`) refreshing the same
 * stored token at once would self-revoke and force re-pairing. We serialize on
 * a per-assistant lock and, once held, re-read the stored token: if another
 * process already rotated it while we waited, we return that fresh token
 * instead of replaying our now-stale refresh token.
 */
/**
 * The guardian refresh token is long-lived and replayable, so we only transmit
 * it over a confidential channel: HTTPS, or a loopback host (local dev, or a
 * same-host reverse proxy / tunnel agent). Refreshing against a non-loopback
 * plaintext `http://` URL is refused — an on-path attacker could otherwise
 * capture the refresh token and rotate it into fresh credentials.
 *
 * A user-chosen malicious `https://` destination is intentionally out of scope:
 * HTTPS protects the channel, and the access token already goes wherever the
 * configured URL points. This guard targets the plaintext-interception vector.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "[::1]" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

function isConfidentialRefreshUrl(gatewayUrl: string): boolean {
  try {
    const url = new URL(gatewayUrl);
    return url.protocol === "https:" || isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * True when a stored guardian token has reached its renewal point — now is
 * at/after `refreshAfter` (preferred) or `accessTokenExpiresAt`. Used to gate
 * refresh so a forged/synthetic 401 on a still-valid token can't coax out the
 * long-lived refresh credential. Unparseable timestamps → not due.
 */
export function guardianTokenDueForRenewal(token: GuardianTokenData): boolean {
  const raw = token.refreshAfter || token.accessTokenExpiresAt;
  const at = new Date(raw).getTime();
  if (!Number.isFinite(at)) return false;
  return at <= Date.now();
}

export async function refreshGuardianToken(
  gatewayUrl: string,
  assistantId: string,
): Promise<GuardianTokenData | null> {
  // Never send the long-lived refresh token over a non-loopback plaintext URL.
  if (!isConfidentialRefreshUrl(gatewayUrl)) {
    console.warn(
      `Refusing to refresh the guardian token over an insecure URL (${gatewayUrl}). ` +
        "The refresh token is only sent over https or a loopback address — " +
        "use an https URL (e.g. a tunnel) or connect over loopback.",
    );
    return null;
  }

  const before = loadGuardianToken(assistantId);
  if (!before) return null;

  // Gateway persists expiresAt as epoch-ms numbers; Date.parse("1234567890000")
  // returns NaN. new Date() accepts both ISO strings and epoch-ms numbers.
  const refreshExpiry = new Date(before.refreshTokenExpiresAt).getTime();
  if (!Number.isFinite(refreshExpiry) || refreshExpiry <= Date.now())
    return null;

  const lockPath = getRefreshLockPath(assistantId);
  const locked = await acquireRefreshLock(lockPath);
  try {
    // Re-read under the lock: a concurrent process may have rotated the token
    // while we waited. If the stored refresh token changed, ours is now stale
    // (replaying it would trip reuse-detection) — use the fresh token instead.
    const current = loadGuardianToken(assistantId);
    if (current && current.refreshToken !== before.refreshToken) {
      return current;
    }

    // We did NOT acquire the lock (another process is likely mid-refresh) and
    // the stored token hasn't been rotated yet. Do NOT call the gateway: our
    // refresh token may be the one the winner is rotating right now, and
    // replaying a rotated token revokes the whole family (forcing re-pair).
    // Give up — the caller surfaces the original 401, and the next attempt
    // picks up the winner's persisted token.
    if (!locked) return null;

    const tokenData = current ?? before;

    const response = await loopbackSafeFetch(`${gatewayUrl}/v1/guardian/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenData.accessToken}`,
      },
      body: JSON.stringify({
        refreshToken: tokenData.refreshToken,
        // The refresh token is device-bound; send the device id used at init
        // (falling back to a fresh computation for tokens persisted before the
        // field was stored) so the gateway can verify the binding.
        deviceId: tokenData.deviceId || computeDeviceId(),
      }),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const json = (await response.json()) as Record<string, unknown>;
    const refreshed: GuardianTokenData = {
      guardianPrincipalId:
        (json.guardianPrincipalId as string) ?? tokenData.guardianPrincipalId,
      accessToken: json.accessToken as string,
      accessTokenExpiresAt:
        (json.accessTokenExpiresAt as string | number) ??
        tokenData.accessTokenExpiresAt,
      refreshToken: (json.refreshToken as string) ?? tokenData.refreshToken,
      refreshTokenExpiresAt:
        (json.refreshTokenExpiresAt as string | number) ??
        tokenData.refreshTokenExpiresAt,
      refreshAfter: (json.refreshAfter as string) ?? tokenData.refreshAfter,
      isNew: false,
      deviceId: tokenData.deviceId,
      leasedAt: new Date().toISOString(),
    };
    saveGuardianToken(assistantId, refreshed);
    return refreshed;
  } catch {
    return null;
  } finally {
    if (locked) releaseRefreshLock(lockPath);
  }
}

/**
 * Call POST /v1/guardian/init on the remote gateway to bootstrap a JWT
 * credential pair. The returned tokens are persisted locally under
 * `$XDG_CONFIG_HOME/vellum{-env}/assistants/<assistantId>/guardian-token.json`.
 */
export async function leaseGuardianToken(
  gatewayUrl: string,
  assistantId: string,
  bootstrapSecret?: string,
): Promise<GuardianTokenData> {
  const deviceId = computeDeviceId();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bootstrapSecret) {
    headers["x-bootstrap-secret"] = bootstrapSecret;
  }
  const response = await loopbackSafeFetch(`${gatewayUrl}/v1/guardian/init`, {
    method: "POST",
    headers,
    body: JSON.stringify({ platform: "cli", deviceId }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`guardian/init failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const tokenData: GuardianTokenData = {
    guardianPrincipalId: json.guardianPrincipalId as string,
    accessToken: json.accessToken as string,
    accessTokenExpiresAt: json.accessTokenExpiresAt as string | number,
    refreshToken: json.refreshToken as string,
    refreshTokenExpiresAt: json.refreshTokenExpiresAt as string | number,
    refreshAfter: json.refreshAfter as string,
    isNew: json.isNew as boolean,
    deviceId,
    leasedAt: new Date().toISOString(),
  };

  saveGuardianToken(assistantId, tokenData);
  return tokenData;
}

/**
 * Clear the gateway's guardian-init lock + consumed-secret state via
 * `POST /v1/guardian/reset-bootstrap`, so a spent single-use bootstrap secret
 * can be used again by a subsequent `leaseGuardianToken`. Loopback-only on the
 * gateway; when bootstrap secrets are configured the gateway requires a
 * matching `x-bootstrap-secret`. Mirrors the macOS client's `forceReBootstrap`
 * recovery. Throws on a non-OK response.
 */
export async function resetGuardianBootstrap(
  gatewayUrl: string,
  bootstrapSecret?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bootstrapSecret) {
    headers["x-bootstrap-secret"] = bootstrapSecret;
  }
  const response = await fetch(`${gatewayUrl}/v1/guardian/reset-bootstrap`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `guardian/reset-bootstrap failed (${response.status}): ${body}`,
    );
  }
}

/**
 * Copy a guardian token from a sibling environment's config directory into
 * the current environment's dir when the current one is missing it.
 *
 * The CLI's per-environment config layout (`~/.config/vellum{-env}/`) scopes
 * the lockfile and the guardian token by VELLUM_ENVIRONMENT. Lockfiles are
 * cross-written at hatch time, but a guardian token is only written under
 * the env the assistant was hatched in. If the user later wakes the same
 * assistant under a different env (e.g. a freshly built desktop app ships
 * with VELLUM_ENVIRONMENT=local while the original hatch was under dev),
 * the app cannot locate a bearer token and falls into a 401 → auth-rate-
 * limit → 429 cascade against the local gateway.
 *
 * Returns true if a token was seeded, false if a token was already present
 * or no sibling env had one to copy.
 */
export function seedGuardianTokenFromSiblingEnv(assistantId: string): boolean {
  if (loadGuardianToken(assistantId) !== null) return false;

  const currentEnvName = getCurrentEnvironment().name;
  const destPath = getGuardianTokenPath(assistantId);

  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const env of Object.values(SEEDS)) {
    if (env.name === currentEnvName) continue;
    const sibling = join(
      getConfigDir(env),
      "assistants",
      assistantId,
      "guardian-token.json",
    );
    try {
      const stat = statSync(sibling);
      candidates.push({ path: sibling, mtimeMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const now = Date.now();
  for (const { path: sibling } of candidates) {
    try {
      const raw = readFileSync(sibling);
      const parsed = JSON.parse(raw.toString("utf-8")) as GuardianTokenData;
      const refreshExpiry = new Date(parsed.refreshTokenExpiresAt).getTime();
      if (!Number.isFinite(refreshExpiry) || refreshExpiry <= now) continue;
      const dir = dirname(destPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      writeFileSync(destPath, raw, { mode: 0o600 });
      chmodSync(destPath, 0o600);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { platform } from "os";
import { dirname, join } from "path";

import { getConfigDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { SEEDS } from "./environments/seeds.js";

const DEVICE_ID_SALT = "vellum-assistant-host-id";

export interface GuardianTokenData {
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  refreshAfter: string;
  isNew: boolean;
  deviceId: string;
  leasedAt: string;
}

function getGuardianTokenPath(assistantId: string): string {
  return join(
    getConfigDir(getCurrentEnvironment()),
    "assistants",
    assistantId,
    "guardian-token.json",
  );
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
 * - macOS: SHA-256 of IOPlatformUUID + salt (matches PairingQRCodeSheet.computeHostId)
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
  const response = await fetch(`${gatewayUrl}/v1/guardian/init`, {
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
    accessTokenExpiresAt: json.accessTokenExpiresAt as string,
    refreshToken: json.refreshToken as string,
    refreshTokenExpiresAt: json.refreshTokenExpiresAt as string,
    refreshAfter: json.refreshAfter as string,
    isNew: json.isNew as boolean,
    deviceId,
    leasedAt: new Date().toISOString(),
  };

  saveGuardianToken(assistantId, tokenData);
  return tokenData;
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

  for (const env of Object.values(SEEDS)) {
    if (env.name === currentEnvName) continue;
    const sibling = join(
      getConfigDir(env),
      "assistants",
      assistantId,
      "guardian-token.json",
    );
    if (!existsSync(sibling)) continue;
    try {
      const raw = readFileSync(sibling);
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

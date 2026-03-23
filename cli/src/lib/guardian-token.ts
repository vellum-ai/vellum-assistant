import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir, platform } from "os";
import { dirname, join } from "path";

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

function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

function getGuardianTokenPath(assistantId: string): string {
  return join(
    getXdgConfigHome(),
    "vellum",
    "assistants",
    assistantId,
    "guardian-token.json",
  );
}

function getPersistedDeviceIdPath(): string {
  return join(getXdgConfigHome(), "vellum", "device-id");
}

function getBootstrapSecretPath(assistantId: string): string {
  return join(
    getXdgConfigHome(),
    "vellum",
    "assistants",
    assistantId,
    "bootstrap-secret",
  );
}

/**
 * Load a previously saved bootstrap secret for the given assistant.
 * Returns null if the file does not exist or is unreadable.
 */
export function loadBootstrapSecret(assistantId: string): string | null {
  try {
    const raw = readFileSync(
      getBootstrapSecretPath(assistantId),
      "utf-8",
    ).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persist a bootstrap secret for the given assistant so that the desktop
 * client and upgrade/rollback paths can retrieve it later.
 */
export function saveBootstrapSecret(assistantId: string, secret: string): void {
  const path = getBootstrapSecretPath(assistantId);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
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

function getOrCreatePersistedDeviceId(): string {
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
 * `$XDG_CONFIG_HOME/vellum/assistants/<assistantId>/guardian-token.json`.
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
  const secret = bootstrapSecret ?? loadBootstrapSecret(assistantId);
  if (secret) {
    headers["x-bootstrap-secret"] = secret;
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

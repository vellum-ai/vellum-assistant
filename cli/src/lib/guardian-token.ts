import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { homedir } from "os";
import { dirname, join } from "path";

export interface GuardianTokenData {
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  refreshAfter: string;
  isNew: boolean;
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
): Promise<GuardianTokenData> {
  const deviceId = randomUUID();
  const response = await fetch(`${gatewayUrl}/v1/guardian/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    leasedAt: new Date().toISOString(),
  };

  saveGuardianToken(assistantId, tokenData);
  return tokenData;
}

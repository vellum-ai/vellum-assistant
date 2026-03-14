import {
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const DEFAULT_PLATFORM_URL = "https://platform.vellum.ai";

function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

function getPlatformTokenPath(): string {
  return join(getXdgConfigHome(), "vellum", "platform-token");
}

export function getPlatformUrl(): string {
  return process.env.VELLUM_PLATFORM_URL ?? DEFAULT_PLATFORM_URL;
}

export function readPlatformToken(): string | null {
  try {
    return readFileSync(getPlatformTokenPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

export function savePlatformToken(token: string): void {
  const tokenPath = getPlatformTokenPath();
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
}

export function clearPlatformToken(): void {
  try {
    unlinkSync(getPlatformTokenPath());
  } catch {
    // already doesn't exist
  }
}

export interface PlatformUser {
  id: string;
  email: string;
  display: string;
}

interface OrganizationListResponse {
  results: { id: string; name: string }[];
}

export async function fetchOrganizationId(token: string): Promise<string> {
  const url = `${getPlatformUrl()}/v1/organizations/`;
  const response = await fetch(url, {
    headers: { "X-Session-Token": token },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch organizations (${response.status}). Try logging in again.`,
    );
  }

  const body = (await response.json()) as OrganizationListResponse;
  const orgId = body.results?.[0]?.id;
  if (!orgId) {
    throw new Error("No organization found for this account.");
  }
  return orgId;
}

interface AllauthSessionResponse {
  status: number;
  data: {
    user: {
      id: string;
      email: string;
      display: string;
    };
  };
}

export async function fetchCurrentUser(token: string): Promise<PlatformUser> {
  const url = `${getPlatformUrl()}/_allauth/app/v1/auth/session`;
  const response = await fetch(url, {
    headers: { "X-Session-Token": token },
  });

  if (!response.ok) {
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 410
    ) {
      throw new Error("Invalid or expired token. Please login again.");
    }
    throw new Error(
      `Platform API error: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as AllauthSessionResponse;
  return body.data.user;
}

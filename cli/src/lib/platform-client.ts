import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const PLATFORM_TOKEN_PATH = join(homedir(), ".vellum", "platform-token");
const DEFAULT_PLATFORM_URL = "https://platform.vellum.ai";

export function getPlatformUrl(): string {
  return process.env.VELLUM_PLATFORM_URL ?? DEFAULT_PLATFORM_URL;
}

export function readPlatformToken(): string | null {
  try {
    return readFileSync(PLATFORM_TOKEN_PATH, "utf-8").trim();
  } catch {
    return null;
  }
}

export function savePlatformToken(token: string): void {
  const dir = dirname(PLATFORM_TOKEN_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(PLATFORM_TOKEN_PATH, token + "\n", { mode: 0o600 });
}

export function clearPlatformToken(): void {
  try {
    unlinkSync(PLATFORM_TOKEN_PATH);
  } catch {
    // already doesn't exist
  }
}

export interface PlatformUser {
  id: string;
  email: string;
  display: string;
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
    if (response.status === 401 || response.status === 403 || response.status === 410) {
      throw new Error("Invalid or expired token. Please login again.");
    }
    throw new Error(`Platform API error: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as AllauthSessionResponse;
  return body.data.user;
}

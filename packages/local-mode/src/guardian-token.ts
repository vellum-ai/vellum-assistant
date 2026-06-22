import { spawn } from "node:child_process";
import fs from "node:fs";

import { guardianTokenPath } from "./config";
import type { CliInvocation } from "./util";

const GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS = 15_000;

interface GuardianTokenData {
  accessToken: string;
  accessTokenExpiresAt: string | number;
  refreshToken: string;
  refreshTokenExpiresAt: string | number;
}

function isAccessTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt - 60_000;
}

function isRefreshTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.refreshTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt;
}

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; status: number; error: string };

export function getGuardianAccessToken(
  assistantId: string,
  configDir: string,
  invocation: CliInvocation,
  isLoopback: boolean,
  env?: Record<string, string>,
): Promise<TokenResult> {
  if (!isLoopback) {
    return Promise.resolve({ ok: false, status: 403, error: "Forbidden" });
  }

  const tokenPath = guardianTokenPath(configDir, assistantId);

  let raw: string;
  try {
    raw = fs.readFileSync(tokenPath, "utf-8");
  } catch {
    return Promise.resolve({ ok: false, status: 404, error: "Guardian token not found" });
  }

  let data: GuardianTokenData;
  try {
    data = JSON.parse(raw) as GuardianTokenData;
  } catch {
    return Promise.resolve({ ok: false, status: 500, error: "Malformed guardian token file" });
  }

  if (!isAccessTokenExpired(data)) {
    return Promise.resolve({ ok: true, accessToken: data.accessToken });
  }

  if (isRefreshTokenExpired(data)) {
    return Promise.resolve({
      ok: false,
      status: 401,
      error: "Guardian token expired — re-run `vellum hatch` or `vellum wake`",
    });
  }

  return refreshToken(assistantId, invocation, env);
}

function refreshToken(
  assistantId: string,
  invocation: CliInvocation,
  env?: Record<string, string>,
): Promise<TokenResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, "gateway", "token", "refresh", assistantId],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );

    let stdout = "";
    let done = false;

    const finish = (result: TokenResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, status: 500, error: "Guardian token refresh timed out" });
    }, GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const accessToken = stdout.trim();
        if (accessToken) {
          finish({ ok: true, accessToken });
        } else {
          finish({ ok: false, status: 500, error: "CLI returned empty token" });
        }
      } else {
        finish({ ok: false, status: 401, error: "Failed to refresh guardian token" });
      }
    });

    child.on("error", (err) => {
      finish({ ok: false, status: 500, error: `Failed to spawn CLI: ${err.message}` });
    });
  });
}

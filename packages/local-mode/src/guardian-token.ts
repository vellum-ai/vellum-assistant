import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { guardianTokenPath, resolveConfigDirPaths } from "./config";
import type { CliInvocation } from "./util";

const GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS = 15_000;
const guardianTokenRefreshes = new Map<string, Promise<TokenResult>>();

export const PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR =
  "Paired assistant credentials are available only through the paired gateway proxy";
export const PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR =
  "Paired assistant target does not match the stored pairing";

/** The persisted shape of an assistant's guardian token file. */
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
  /** Remote gateway bound to a credential imported through the pairing flow. */
  pairedGatewayUrl?: string;
}

/**
 * Persist an assistant's guardian token where every host-seam reader resolves
 * it (`guardianTokenPath`). The per-assistant directory is created 0700 and the
 * file written 0600; chmod after the write covers a pre-existing file whose
 * mode drifted.
 */
export function saveGuardianToken(
  configDir: string,
  assistantId: string,
  data: GuardianTokenData,
): void {
  const tokenPath = guardianTokenPath(configDir, assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(tokenPath, 0o600);
}

/**
 * The guardian refresh token is long-lived and replayable, so it is only
 * transmitted over a confidential channel: HTTPS, or a loopback host (local
 * dev, or a same-host reverse proxy / tunnel agent). Refreshing against a
 * non-loopback plaintext `http://` URL is refused; an on-path attacker could
 * otherwise capture the refresh token and rotate it into fresh credentials.
 *
 * A user-chosen malicious `https://` destination is intentionally out of
 * scope: HTTPS protects the channel, and the access token already goes
 * wherever the configured URL points. This guard targets the
 * plaintext-interception vector.
 */
function isLoopbackHostname(hostname: string): boolean {
  // Strip URL brackets so IPv6 forms compare on the bare address.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    // Wildcard hosts reach a local listener when dialed (0.0.0.0 / ::), so
    // they count as local for both the refresh-channel and pairing guards.
    h === "0.0.0.0" ||
    h === "0" ||
    h === "::" ||
    h === "0:0:0:0:0:0:0:0" ||
    // IPv4-mapped loopback and wildcard, in dotted and hex encodings.
    /^(?:0:0:0:0:0|:):ffff:127(?:\.\d{1,3}){3}$/.test(h) ||
    /^(?:0:0:0:0:0|:):ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h) ||
    /^(?:0:0:0:0:0|:):ffff:0\.0\.0\.0$/.test(h) ||
    /^(?:0:0:0:0:0|:):ffff:0:0$/.test(h)
  );
}

export function isConfidentialRefreshUrl(gatewayUrl: string): boolean {
  try {
    const url = new URL(gatewayUrl);
    return url.protocol === "https:" || isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/** Whether a URL's host is loopback; false for unparseable URLs. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
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

/**
 * Prefix of the machine-readable line `vellum gateway token refresh` writes
 * to stderr on failure so hosts can distinguish a spent credential (401)
 * from an unreachable gateway (503) without scraping the human message.
 */
export const GUARDIAN_REFRESH_ERROR_PREFIX = "VELLUM_REFRESH_ERROR=";

/** Encode a structured refresh failure for the CLI's stderr. */
export function formatGuardianRefreshCliFailure(
  status: number,
  error: string,
): string {
  return `${GUARDIAN_REFRESH_ERROR_PREFIX}${JSON.stringify({ status, error })}`;
}

/**
 * Read the structured status out of a failed `vellum gateway token refresh`.
 * An unlabeled non-zero exit defaults to 503: this spawn only runs when the
 * on-disk refresh token is still unexpired, so a bare CLI failure is an
 * unreachable or still-starting gateway, not a spent credential.
 */
export function parseGuardianRefreshCliFailure(
  stdout: string,
  stderr: string,
): TokenResult {
  const blob = `${stderr}\n${stdout}`;
  for (const line of blob.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(GUARDIAN_REFRESH_ERROR_PREFIX)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(
        trimmed.slice(GUARDIAN_REFRESH_ERROR_PREFIX.length),
      );
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("status" in parsed) ||
        typeof (parsed as { status: unknown }).status !== "number"
      ) {
        continue;
      }
      const status = (parsed as { status: number }).status;
      if (status < 400 || status > 599) {
        continue;
      }
      const errorText =
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string" &&
        (parsed as { error: string }).error.trim() !== ""
          ? (parsed as { error: string }).error
          : "Failed to refresh guardian token";
      return { ok: false, status, error: errorText };
    } catch {
      // Keep scanning; a later well-formed line still wins.
    }
  }
  return {
    ok: false,
    status: 503,
    error: "Failed to refresh guardian token",
  };
}

export interface GuardianTokenOptions {
  /**
   * True when the entry was imported from another machine via `vellum pair`.
   * A paired entry has no local daemon, so expired-refresh guidance points at
   * re-pairing instead of `vellum hatch`/`vellum wake`.
   */
  paired?: boolean;
  /** Gateway URL resolved for the paired proxy request. */
  pairedGatewayUrl?: string;
}

export function getGuardianAccessToken(
  assistantId: string,
  configDir: string,
  invocation: CliInvocation,
  isLoopback: boolean,
  env?: Record<string, string>,
  options?: GuardianTokenOptions,
): Promise<TokenResult> {
  if (!isLoopback) {
    return Promise.resolve({ ok: false, status: 403, error: "Forbidden" });
  }

  let tokenPaths: string[];
  try {
    const configDirs = [
      configDir,
      ...resolveConfigDirPaths({ ...process.env, ...env }),
    ];
    tokenPaths = [...new Set(configDirs)].map((dir) =>
      guardianTokenPath(dir, assistantId),
    );
  } catch {
    return Promise.resolve({
      ok: false,
      status: 400,
      error: "Invalid assistant ID",
    });
  }

  let raw: string | undefined;
  let resolvedTokenPath: string | undefined;
  for (const tokenPath of tokenPaths) {
    try {
      raw = fs.readFileSync(tokenPath, "utf-8");
      resolvedTokenPath = tokenPath;
      break;
    } catch {
      // Try the next compatible location.
    }
  }
  if (raw === undefined || resolvedTokenPath === undefined) {
    return Promise.resolve({
      ok: false,
      status: 404,
      error: "Guardian token not found",
    });
  }

  let data: GuardianTokenData;
  try {
    data = JSON.parse(raw) as GuardianTokenData;
  } catch {
    return Promise.resolve({
      ok: false,
      status: 500,
      error: "Malformed guardian token file",
    });
  }

  if (data.pairedGatewayUrl) {
    if (!options?.paired) {
      return Promise.resolve({
        ok: false,
        status: 403,
        error: PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
      });
    }
    if (options.pairedGatewayUrl !== data.pairedGatewayUrl) {
      return Promise.resolve({
        ok: false,
        status: 403,
        error: PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR,
      });
    }
  } else if (options?.paired) {
    if (!options.pairedGatewayUrl) {
      return Promise.resolve({
        ok: false,
        status: 403,
        error: PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR,
      });
    }
    data = { ...data, pairedGatewayUrl: options.pairedGatewayUrl };
    try {
      saveGuardianToken(configDir, assistantId, data);
    } catch {
      return Promise.resolve({
        ok: false,
        status: 500,
        error: "Failed to bind paired assistant credential",
      });
    }
  }

  if (!isAccessTokenExpired(data)) {
    return Promise.resolve({ ok: true, accessToken: data.accessToken });
  }

  if (isRefreshTokenExpired(data)) {
    return Promise.resolve({
      ok: false,
      status: 401,
      error: options?.paired
        ? "Guardian token expired. Run `vellum pair` on the assistant's machine, then re-import it from the app's connect flow or with `vellum connect import`."
        : "Guardian token expired. Re-run `vellum hatch` or `vellum wake`.",
    });
  }

  const existingRefresh = guardianTokenRefreshes.get(resolvedTokenPath);
  if (existingRefresh) {
    return existingRefresh;
  }
  const refresh = refreshToken(assistantId, invocation, env).finally(() => {
    if (guardianTokenRefreshes.get(resolvedTokenPath) === refresh) {
      guardianTokenRefreshes.delete(resolvedTokenPath);
    }
  });
  guardianTokenRefreshes.set(resolvedTokenPath, refresh);
  return refresh;
}

/** Resolve a paired bearer only when the proxy target matches its binding. */
export function getPairedGuardianAccessToken(
  assistantId: string,
  pairedGatewayUrl: string,
  configDir: string,
  invocation: CliInvocation,
  isLoopback: boolean,
  env?: Record<string, string>,
): Promise<TokenResult> {
  return getGuardianAccessToken(
    assistantId,
    configDir,
    invocation,
    isLoopback,
    env,
    { paired: true, pairedGatewayUrl },
  );
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
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...env },
      },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: TokenResult) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: "Guardian token refresh timed out",
      });
    }, GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
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
        // This spawn only runs when the on-disk refresh token is still
        // unexpired. A non-zero CLI exit is therefore a transport or
        // gateway-availability failure unless the CLI labels a spent
        // credential (401) or a local confidentiality refusal (403).
        finish(parseGuardianRefreshCliFailure(stdout, stderr));
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        status: 500,
        error: `Failed to spawn CLI: ${err.message}`,
      });
    });
  });
}

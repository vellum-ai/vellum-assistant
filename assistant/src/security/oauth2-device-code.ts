/**
 * OAuth2 Device Authorization Grant (RFC 8628).
 *
 * Implements the device-code flow for environments where a browser redirect
 * is impractical (CLI, headless). The user visits a verification URI and
 * enters a short code; meanwhile, the client polls the token endpoint until
 * authorization completes.
 *
 * This is intentionally separate from the PKCE authorization code flow in
 * oauth2.ts — different grant type, different UX (no localhost server), and
 * different polling lifecycle.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("oauth2-device-code");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceCodeConfig {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  audience?: string;
}

export interface DeviceCodeInitResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceCodeTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

export class DeviceCodeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "expired_token"
      | "access_denied"
      | "request_failed"
      | "aborted",
  ) {
    super(message);
    this.name = "DeviceCodeError";
  }
}

// ---------------------------------------------------------------------------
// Well-known provider configs
// ---------------------------------------------------------------------------

export const OPENAI_DEVICE_CODE_CONFIG: DeviceCodeConfig = {
  deviceCodeUrl: "https://auth.openai.com/oauth/device/code",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  audience: "https://chatgpt.com",
};

// ---------------------------------------------------------------------------
// Device code request
// ---------------------------------------------------------------------------

export async function requestDeviceCode(
  config: DeviceCodeConfig,
): Promise<DeviceCodeInitResult> {
  const body: Record<string, string> = {
    client_id: config.clientId,
    scope: config.scopes.join(" "),
  };
  if (config.audience) {
    body.audience = config.audience;
  }

  const resp = await fetch(config.deviceCodeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body),
  });

  if (!resp.ok) {
    const rawBody = await resp.text().catch(() => "");
    log.error(
      { status: resp.status, body: rawBody },
      "Device code request failed",
    );
    throw new DeviceCodeError(
      `Device code request failed (HTTP ${resp.status})`,
      "request_failed",
    );
  }

  const data = (await resp.json()) as Record<string, unknown>;

  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUri: data.verification_uri as string,
    verificationUriComplete: data.verification_uri_complete as
      | string
      | undefined,
    expiresIn: data.expires_in as number,
    interval: (data.interval as number | undefined) ?? 5,
  };
}

// ---------------------------------------------------------------------------
// Token polling
// ---------------------------------------------------------------------------

/**
 * Poll the token endpoint until the user completes authorization or the
 * device code expires.
 *
 * Handles RFC 8628 error codes:
 * - `authorization_pending` — keep polling
 * - `slow_down` — increase interval by 5 seconds (per spec)
 * - `expired_token` — abort with error
 * - `access_denied` — abort with error
 */
export async function pollForToken(
  config: DeviceCodeConfig,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  signal?: AbortSignal,
  /** @internal Test-only: override the sleep function to avoid real delays. */
  _sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<DeviceCodeTokenResult> {
  const doSleep = _sleepFn ?? sleep;
  let interval = intervalSeconds;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DeviceCodeError("Device code flow aborted", "aborted");
    }

    await doSleep(interval * 1000, signal);

    if (signal?.aborted) {
      throw new DeviceCodeError("Device code flow aborted", "aborted");
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: config.clientId,
    });

    let resp: Response;
    try {
      resp = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new DeviceCodeError("Device code flow aborted", "aborted");
      }
      log.warn({ err }, "Token poll request failed, will retry");
      continue;
    }

    const data = (await resp.json()) as Record<string, unknown>;

    if (resp.ok) {
      log.info("Device code authorization completed");
      return {
        accessToken: data.access_token as string,
        refreshToken: data.refresh_token as string | undefined,
        expiresIn: data.expires_in as number | undefined,
        tokenType: data.token_type as string | undefined,
        scope: data.scope as string | undefined,
      };
    }

    const errorCode = data.error as string | undefined;

    if (errorCode === "authorization_pending") {
      log.debug("Authorization pending, continuing to poll");
      continue;
    }

    if (errorCode === "slow_down") {
      interval += 5;
      log.info({ newInterval: interval }, "Received slow_down, increasing poll interval");
      continue;
    }

    if (errorCode === "expired_token") {
      throw new DeviceCodeError(
        "Device code expired before user completed authorization",
        "expired_token",
      );
    }

    if (errorCode === "access_denied") {
      throw new DeviceCodeError(
        "User denied the authorization request",
        "access_denied",
      );
    }

    log.error(
      { status: resp.status, error: errorCode },
      "Unexpected token poll error",
    );
    throw new DeviceCodeError(
      `Token poll failed: ${errorCode ?? `HTTP ${resp.status}`}`,
      "request_failed",
    );
  }

  throw new DeviceCodeError(
    "Device code expired before user completed authorization",
    "expired_token",
  );
}

// ---------------------------------------------------------------------------
// Combined flow
// ---------------------------------------------------------------------------

export interface DeviceCodeFlowResult {
  tokens: DeviceCodeTokenResult;
  init: DeviceCodeInitResult;
}

/**
 * Run the full device-code flow:
 * 1. Request a device code + user code
 * 2. Return the user code and verification URI (caller shows these to the user)
 * 3. Poll for the token
 *
 * The returned `init` contains the user code and verification URI that the
 * caller should present to the user before awaiting `tokens`.
 */
export async function startDeviceCodeFlow(
  config: DeviceCodeConfig,
  signal?: AbortSignal,
): Promise<DeviceCodeFlowResult> {
  const init = await requestDeviceCode(config);

  log.info(
    {
      verificationUri: init.verificationUri,
      expiresIn: init.expiresIn,
      interval: init.interval,
    },
    "Device code flow started",
  );

  const tokens = await pollForToken(
    config,
    init.deviceCode,
    init.interval,
    init.expiresIn,
    signal,
  );

  return { tokens, init };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceCodeError("Device code flow aborted", "aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DeviceCodeError("Device code flow aborted", "aborted"));
      },
      { once: true },
    );
  });
}

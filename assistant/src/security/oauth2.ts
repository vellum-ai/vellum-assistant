/**
 * General-purpose OAuth2 Authorization Code flow with PKCE.
 *
 * Supports two callback transports:
 *
 * 1. **Loopback** — starts a temporary HTTP server on localhost to receive the
 *    callback directly. Works without any public URL or tunnel. Used by default
 *    when no public ingress URL is configured, and preferred for providers like
 *    Google that support localhost redirects.
 *
 * 2. **Gateway** — routes callbacks through the gateway's public OAuth route
 *    + in-memory registry. Requires `ingress.publicBaseUrl` to be configured.
 *    Used for providers that don't support localhost redirects (e.g. Slack).
 *
 * Moved from integrations/oauth2.ts. Types that were in integrations/types.ts
 * are now inlined here since the integration framework is removed.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { getLogger } from "../util/logger.js";
import { renderOAuthCompletionPage as renderLoopbackPage } from "./oauth-completion-page.js";

const log = getLogger("oauth2");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenEndpointAuthMethod =
  | "client_secret_basic"
  | "client_secret_post";

export interface OAuth2Config {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  /** Client secret for providers that require it (e.g. Slack). PKCE is always used regardless. */
  clientSecret?: string;
  extraParams?: Record<string, string>;
  /** URL to fetch user identity info after OAuth. If omitted, account info is not fetched. */
  userinfoUrl?: string;
  /**
   * How the client authenticates at the token endpoint when a clientSecret is present.
   * - `client_secret_post`: Send client_id and client_secret in the POST body (default).
   * - `client_secret_basic`: Send an HTTP Basic Auth header with base64(client_id:client_secret).
   * Defaults to `client_secret_post`.
   */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}

export interface OAuth2TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

export interface OAuth2FlowCallbacks {
  /** Open a URL in the user's browser (e.g. via `open_url` message). */
  openUrl: (url: string) => void | Promise<void>;
}

export interface OAuth2FlowOptions {
  /** Which callback transport to use. When omitted, auto-detected from config. */
  callbackTransport?: "loopback" | "gateway";
  /** Fixed port for the loopback server. When set, the server binds to this port
   *  instead of an OS-assigned random port. Required for providers like Slack that
   *  need pre-registered redirect URIs. */
  loopbackPort?: number;
}

export interface OAuth2FlowResult {
  tokens: OAuth2TokenResult;
  grantedScopes: string[];
  rawTokenResponse: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Token exchange (shared between transports)
// ---------------------------------------------------------------------------

async function exchangeCodeForTokens(
  config: OAuth2Config,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OAuth2FlowResult> {
  const authMethod = config.tokenEndpointAuthMethod ?? "client_secret_post";

  const tokenBody: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (config.clientSecret && authMethod === "client_secret_basic") {
    const credentials = Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  } else {
    tokenBody.client_id = config.clientId;
    if (config.clientSecret) {
      tokenBody.client_secret = config.clientSecret;
    }
  }

  const tokenResp = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(tokenBody),
  });

  if (!tokenResp.ok) {
    const rawBody = await tokenResp.text().catch(() => "");
    const safeDetail: Record<string, unknown> = {};
    let errorCode = "";
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.error) {
        safeDetail.error = String(parsed.error);
        errorCode = String(parsed.error);
      }
      if (parsed.error_description)
        safeDetail.error_description = String(parsed.error_description);
    } catch {
      safeDetail.error = "[non-JSON response]";
    }
    log.error(
      { status: tokenResp.status, ...safeDetail },
      "OAuth2 token exchange failed",
    );
    const detail = errorCode
      ? `HTTP ${tokenResp.status}: ${errorCode}`
      : `HTTP ${tokenResp.status}`;
    throw new Error(`OAuth2 token exchange failed (${detail})`);
  }

  const tokenData = (await tokenResp.json()) as Record<string, unknown>;

  // Slack V2 OAuth returns user tokens nested under `authed_user`
  const authedUser = tokenData.authed_user as
    | Record<string, unknown>
    | undefined;
  const tokenSource = authedUser?.access_token ? authedUser : tokenData;

  const tokens: OAuth2TokenResult = {
    accessToken:
      (tokenSource.access_token as string) ??
      (tokenData.access_token as string),
    refreshToken:
      (tokenSource.refresh_token as string | undefined) ??
      (tokenData.refresh_token as string | undefined),
    expiresIn:
      (tokenSource.expires_in as number | undefined) ??
      (tokenData.expires_in as number | undefined),
    scope:
      (tokenSource.scope as string | undefined) ??
      (tokenData.scope as string | undefined),
    tokenType:
      (tokenSource.token_type as string | undefined) ??
      (tokenData.token_type as string | undefined),
  };

  const grantedScopes =
    typeof tokens.scope === "string"
      ? tokens.scope.split(/[ ,]/).filter(Boolean)
      : [...config.scopes];

  return { tokens, grantedScopes, rawTokenResponse: tokenData };
}

// ---------------------------------------------------------------------------
// Gateway transport
// ---------------------------------------------------------------------------

async function runGatewayFlow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  codeVerifier: string,
  codeChallenge: string,
  state: string,
): Promise<OAuth2FlowResult> {
  // Dynamic imports required here to avoid circular dependencies with
  // config/loader → security → oauth2 module chains.
  const { loadConfig } = await import("../config/loader.js");
  const { getOAuthCallbackUrl } =
    await import("../inbound/public-ingress-urls.js");
  const { resolveCallbackUrl } =
    await import("../inbound/platform-callback-registration.js");
  const { registerPendingCallback } =
    await import("./oauth-callback-registry.js");

  const appConfig = loadConfig();
  const redirectUri = await resolveCallbackUrl(
    () => getOAuthCallbackUrl(appConfig),
    "webhooks/oauth/callback",
    "oauth",
  );

  const codePromise = new Promise<string>((resolve, reject) => {
    registerPendingCallback(state, resolve, reject);
  });

  const authParams = new URLSearchParams({
    ...config.extraParams,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${config.authUrl}?${authParams}`;
  callbacks.openUrl(authUrl);

  const code = await codePromise;

  return await exchangeCodeForTokens(config, code, redirectUri, codeVerifier);
}

// ---------------------------------------------------------------------------
// Loopback transport
// ---------------------------------------------------------------------------

const LOOPBACK_CALLBACK_PATH = "/oauth/callback";
const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function runLoopbackFlow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  codeVerifier: string,
  codeChallenge: string,
  state: string,
  loopbackPort?: number,
): Promise<OAuth2FlowResult> {
  const { code, redirectUri } = await startLoopbackServerAndWaitForCode(
    config,
    callbacks,
    codeChallenge,
    state,
    loopbackPort,
  );

  return await exchangeCodeForTokens(config, code, redirectUri, codeVerifier);
}

/**
 * Start a temporary HTTP server on localhost, build the auth URL with
 * a localhost redirect_uri, open the browser, and wait for the callback.
 * When `loopbackPort` is set, binds to that fixed port (for providers
 * that require pre-registered redirect URIs); otherwise uses a random port.
 */
function startLoopbackServerAndWaitForCode(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  codeChallenge: string,
  state: string,
  loopbackPort?: number,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let boundRedirectUri = "";

    const server: Server = createServer((req, res) => {
      log.info(
        {
          method: req.method,
          path: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
          settled,
        },
        "oauth2 loopback: received request",
      );

      if (settled) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderLoopbackPage("Authorization already completed", false));
        return;
      }

      const url = new URL(req.url ?? "/", `http://127.0.0.1`);

      if (url.pathname !== LOOPBACK_CALLBACK_PATH) {
        log.info(
          { pathname: url.pathname },
          "oauth2 loopback: non-callback path, returning 404",
        );
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const callbackState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (callbackState !== state) {
        log.warn("oauth2 loopback: state mismatch in callback");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderLoopbackPage("Invalid state parameter", false));
        return;
      }

      settled = true;

      if (error) {
        const errorDesc = url.searchParams.get("error_description") ?? error;
        log.error(
          { error, errorDesc },
          "oauth2 loopback: authorization denied by user/provider",
        );
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          renderLoopbackPage(`Authorization failed: ${errorDesc}`, false),
        );
        cleanup();
        reject(new Error(`OAuth2 authorization denied: ${error}`));
        return;
      }

      if (!code) {
        log.error("oauth2 loopback: callback missing authorization code");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderLoopbackPage("Missing authorization code", false));
        cleanup();
        reject(new Error("OAuth2 callback missing authorization code"));
        return;
      }

      log.info(
        "oauth2 loopback: authorization code received, exchanging for tokens",
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        renderLoopbackPage(
          "You can close this tab and return to your assistant.",
          true,
        ),
      );
      cleanup();
      resolve({ code, redirectUri: boundRedirectUri });
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        log.warn(
          { timeoutMs: LOOPBACK_TIMEOUT_MS, state },
          "oauth2 loopback: callback timed out — no authorization code received",
        );
        settled = true;
        cleanup();
        reject(new Error("OAuth2 loopback callback timed out"));
      }
    }, LOOPBACK_TIMEOUT_MS);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    log.info(
      { requestedPort: loopbackPort ?? "random" },
      "oauth2 loopback: binding server",
    );

    server.listen(loopbackPort ?? 0, "localhost", () => {
      const addr = server.address() as { port: number };
      boundRedirectUri = `http://localhost:${addr.port}${LOOPBACK_CALLBACK_PATH}`;

      log.info(
        { port: addr.port, redirectUri: boundRedirectUri },
        "oauth2 loopback: server listening",
      );

      const authParams = new URLSearchParams({
        ...config.extraParams,
        client_id: config.clientId,
        redirect_uri: boundRedirectUri,
        response_type: "code",
        scope: config.scopes.join(" "),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const authUrl = `${config.authUrl}?${authParams}`;
      log.info(
        { authUrlLength: authUrl.length, state },
        "oauth2 loopback: built auth URL, calling openUrl callback",
      );
      callbacks.openUrl(authUrl);
      log.info("oauth2 loopback: openUrl callback returned");
    });

    server.on("error", (err) => {
      log.error(
        { err: err.message, loopbackPort },
        "oauth2 loopback: server error",
      );
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`OAuth2 loopback server error: ${err.message}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OAuth2PreparedFlow {
  authUrl: string;
  state: string;
  /** Resolves when the user completes authorization and tokens are exchanged. */
  completion: Promise<OAuth2FlowResult>;
}

/**
 * Build an OAuth2 auth URL and register a pending callback, without opening
 * the URL or blocking. Used by channel sessions where the LLM sends the auth
 * URL directly in chat and the callback arrives asynchronously via the gateway.
 *
 * Supports two transports:
 * - **loopback** (default): starts a temporary localhost server to receive the
 *   callback. Works without any public URL or tunnel.
 * - **gateway**: routes callbacks through the public ingress URL.
 *   Requires `ingress.publicBaseUrl` to be configured. Used for providers that
 *   don't support localhost redirects (e.g. Twitter, Notion).
 */
export async function prepareOAuth2Flow(
  config: OAuth2Config,
  options?: OAuth2FlowOptions,
): Promise<OAuth2PreparedFlow> {
  const transport = options?.callbackTransport ?? "loopback";

  if (transport === "loopback") {
    return prepareLoopbackFlow(config, options?.loopbackPort);
  }

  // Dynamic imports required here to avoid circular dependencies with
  // config/loader → security → oauth2 module chains.
  const { loadConfig } = await import("../config/loader.js");
  const { getOAuthCallbackUrl } =
    await import("../inbound/public-ingress-urls.js");
  const { resolveCallbackUrl } =
    await import("../inbound/platform-callback-registration.js");
  const { registerPendingCallback } =
    await import("./oauth-callback-registry.js");

  const appConfig = loadConfig();
  const redirectUri = await resolveCallbackUrl(
    () => getOAuthCallbackUrl(appConfig),
    "webhooks/oauth/callback",
    "oauth",
  );

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const codePromise = new Promise<string>((resolve, reject) => {
    registerPendingCallback(state, resolve, reject);
  });

  const authParams = new URLSearchParams({
    ...config.extraParams,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${config.authUrl}?${authParams}`;

  const completion = codePromise.then(async (code) => {
    return await exchangeCodeForTokens(config, code, redirectUri, codeVerifier);
  });

  log.debug({ transport: "gateway", state }, "Prepared deferred OAuth2 flow");

  return { authUrl, state, completion };
}

/**
 * Prepare an OAuth2 flow using a loopback server. The server starts immediately
 * and waits for the callback. The auth URL uses a localhost redirect URI
 * matching the server's bound port.
 */
async function prepareLoopbackFlow(
  config: OAuth2Config,
  loopbackPort?: number,
): Promise<OAuth2PreparedFlow> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const { redirectUri, codePromise } = await startLoopbackServerForPreparedFlow(
    state,
    loopbackPort,
  );

  const authParams = new URLSearchParams({
    ...config.extraParams,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${config.authUrl}?${authParams}`;

  const completion = codePromise.then(async (code) => {
    return await exchangeCodeForTokens(config, code, redirectUri, codeVerifier);
  });

  log.debug(
    { transport: "loopback", loopbackPort, state },
    "Prepared deferred OAuth2 flow (loopback)",
  );

  return { authUrl, state, completion };
}

/**
 * Start a loopback server and return the redirect URI and a promise that
 * resolves with the authorization code. Unlike startLoopbackServerAndWaitForCode,
 * this does not open the browser — the caller is responsible for delivering
 * the auth URL to the user.
 */
function startLoopbackServerForPreparedFlow(
  state: string,
  loopbackPort?: number,
): Promise<{ redirectUri: string; codePromise: Promise<string> }> {
  return new Promise((resolveSetup, rejectSetup) => {
    let settled = false;
    let listening = false;
    let codeResolve: (code: string) => void;
    let codeReject: (err: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      codeResolve = resolve;
      codeReject = reject;
    });

    const server: Server = createServer((req, res) => {
      if (settled) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderLoopbackPage("Authorization already completed", false));
        return;
      }

      const url = new URL(req.url ?? "/", `http://127.0.0.1`);

      if (url.pathname !== LOOPBACK_CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const callbackState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (callbackState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderLoopbackPage("Invalid state parameter", false));
        return;
      }

      settled = true;

      if (error) {
        const errorDesc = url.searchParams.get("error_description") ?? error;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          renderLoopbackPage(`Authorization failed: ${errorDesc}`, false),
        );
        cleanup();
        codeReject(new Error(`OAuth2 authorization denied: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderLoopbackPage("Missing authorization code", false));
        cleanup();
        codeReject(new Error("OAuth2 callback missing authorization code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        renderLoopbackPage(
          "You can close this tab and return to your assistant.",
          true,
        ),
      );
      cleanup();
      codeResolve(code);
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        codeReject(new Error("OAuth2 loopback callback timed out"));
      }
    }, LOOPBACK_TIMEOUT_MS);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    server.listen(loopbackPort ?? 0, "localhost", () => {
      const addr = server.address() as { port: number };
      const redirectUri = `http://localhost:${addr.port}${LOOPBACK_CALLBACK_PATH}`;
      listening = true;
      resolveSetup({ redirectUri, codePromise });
    });

    server.on("error", (err) => {
      const message = `OAuth2 loopback server error: ${err.message}`;
      if (!listening) {
        // Pre-startup error (e.g. port in use): resolveSetup was never called,
        // so codePromise has no consumer — only reject the setup promise.
        settled = true;
        cleanup();
        rejectSetup(new Error(message));
      } else if (!settled) {
        // Post-startup error: setup promise already resolved, reject codePromise
        // so the caller waiting on it receives the error.
        settled = true;
        cleanup();
        codeReject(new Error(message));
      }
    });
  });
}

/**
 * Run a full OAuth2 authorization code flow with PKCE support.
 *
 * Transport selection:
 * - If `callbackTransport` is explicitly set, that transport is used.
 * - Otherwise, uses gateway transport when a public ingress URL is configured,
 *   and falls back to loopback (localhost) when it is not.
 */
export async function startOAuth2Flow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  options?: OAuth2FlowOptions,
): Promise<OAuth2FlowResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  let hasPublicUrl = false;
  try {
    // Dynamic imports required here to avoid circular dependencies with
    // config/loader → security → oauth2 module chains.
    const { loadConfig } = await import("../config/loader.js");
    const { getPublicBaseUrl } =
      await import("../inbound/public-ingress-urls.js");
    getPublicBaseUrl(loadConfig());
    hasPublicUrl = true;
  } catch {
    // No public URL configured
  }

  // When containerized with a platform, callback routes are registered
  // through the platform gateway — treat as having a public URL.
  if (!hasPublicUrl) {
    const { shouldUsePlatformCallbacks } =
      await import("../inbound/platform-callback-registration.js");
    if (shouldUsePlatformCallbacks()) {
      hasPublicUrl = true;
    }
  }

  // Determine transport: explicit option > auto-detect from config
  const transport =
    options?.callbackTransport ?? (hasPublicUrl ? "gateway" : "loopback");

  log.info(
    {
      transport,
      hasPublicUrl,
      explicitTransport: options?.callbackTransport,
      loopbackPort: options?.loopbackPort,
    },
    "startOAuth2Flow: resolved transport",
  );

  if (transport === "gateway") {
    if (!hasPublicUrl) {
      throw new Error(
        "Gateway transport requires a public ingress URL. Set ingress.publicBaseUrl, or use loopback transport.",
      );
    }
    log.debug({ transport: "gateway" }, "OAuth2 flow starting");
    return runGatewayFlow(
      config,
      callbacks,
      codeVerifier,
      codeChallenge,
      state,
    );
  }

  log.debug(
    { transport: "loopback", loopbackPort: options?.loopbackPort },
    "OAuth2 flow starting",
  );
  return runLoopbackFlow(
    config,
    callbacks,
    codeVerifier,
    codeChallenge,
    state,
    options?.loopbackPort,
  );
}

/**
 * Refresh an OAuth2 access token using a refresh token.
 * Supports both PKCE (no secret) and client_secret flows.
 */
export async function refreshOAuth2Token(
  tokenUrl: string,
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod,
): Promise<OAuth2TokenResult> {
  const authMethod = tokenEndpointAuthMethod ?? "client_secret_post";

  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (clientSecret && authMethod === "client_secret_basic") {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );
    headers["Authorization"] = `Basic ${credentials}`;
  } else {
    body.client_id = clientId;
    if (clientSecret) {
      body.client_secret = clientSecret;
    }
  }

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(body),
  });

  if (!resp.ok) {
    const rawBody = await resp.text().catch(() => "");
    const safeDetail: Record<string, unknown> = {};
    let errorCode = "";
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.error) {
        safeDetail.error = String(parsed.error);
        errorCode = String(parsed.error);
      }
      if (parsed.error_description)
        safeDetail.error_description = String(parsed.error_description);
    } catch {
      safeDetail.error = "[non-JSON response]";
    }
    log.error(
      { status: resp.status, ...safeDetail },
      "OAuth2 token refresh failed",
    );
    const detail = errorCode
      ? `HTTP ${resp.status}: ${errorCode}`
      : `HTTP ${resp.status}`;
    throw new Error(`OAuth2 token refresh failed (${detail})`);
  }

  const data = (await resp.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
    expiresIn: data.expires_in as number | undefined,
    scope: data.scope as string | undefined,
    tokenType: data.token_type as string | undefined,
  };
}

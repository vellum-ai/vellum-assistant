/**
 * General-purpose OAuth2 Authorization Code flow with PKCE.
 *
 * Supports two callback transports:
 *   - loopback: spins up a local HTTP server on 127.0.0.1 (default when no public URL configured)
 *   - gateway:  uses the gateway's OAuth callback route + in-memory registry (when ingress.publicBaseUrl is set)
 *
 * Moved from integrations/oauth2.ts. Types that were in integrations/types.ts
 * are now inlined here since the integration framework is removed.
 */

import { randomBytes, createHash } from 'node:crypto';
import { getLogger } from '../util/logger.js';

const log = getLogger('oauth2');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuth2Config {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  /** Client secret for providers that require it (e.g. Slack). If omitted, PKCE is used. */
  clientSecret?: string;
  extraParams?: Record<string, string>;
  /** URL to fetch user identity info after OAuth. If omitted, account info is not fetched. */
  userinfoUrl?: string;
}

export interface OAuth2TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

export interface OAuth2FlowCallbacks {
  /** Open a URL in the user's browser (e.g. via IPC `open_url`). */
  openUrl: (url: string) => void;
}

export interface OAuth2FlowOptions {
  /** Which callback transport to use. When omitted, auto-detected from config. */
  callbackTransport?: 'loopback' | 'gateway';
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
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
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
  const usePKCE = !config.clientSecret;

  const tokenBody: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
  };
  if (usePKCE) {
    tokenBody.code_verifier = codeVerifier;
  }
  if (config.clientSecret) {
    tokenBody.client_secret = config.clientSecret;
  }

  const tokenResp = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenBody),
  });

  if (!tokenResp.ok) {
    const rawBody = await tokenResp.text().catch(() => '');
    const safeDetail: Record<string, unknown> = {};
    let errorCode = '';
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.error) { safeDetail.error = String(parsed.error); errorCode = String(parsed.error); }
      if (parsed.error_description) safeDetail.error_description = String(parsed.error_description);
    } catch {
      safeDetail.error = '[non-JSON response]';
    }
    log.error({ status: tokenResp.status, ...safeDetail }, 'OAuth2 token exchange failed');
    const detail = errorCode ? `HTTP ${tokenResp.status}: ${errorCode}` : `HTTP ${tokenResp.status}`;
    throw new Error(`OAuth2 token exchange failed (${detail})`);
  }

  const tokenData = await tokenResp.json() as Record<string, unknown>;

  // Slack V2 OAuth returns user tokens nested under `authed_user`
  const authedUser = tokenData.authed_user as Record<string, unknown> | undefined;
  const tokenSource = authedUser?.access_token ? authedUser : tokenData;

  const tokens: OAuth2TokenResult = {
    accessToken: (tokenSource.access_token as string) ?? (tokenData.access_token as string),
    refreshToken: (tokenSource.refresh_token as string | undefined) ?? (tokenData.refresh_token as string | undefined),
    expiresIn: (tokenSource.expires_in as number | undefined) ?? (tokenData.expires_in as number | undefined),
    scope: (tokenSource.scope as string | undefined) ?? (tokenData.scope as string | undefined),
    tokenType: (tokenSource.token_type as string | undefined) ?? (tokenData.token_type as string | undefined),
  };

  const grantedScopes = typeof tokens.scope === 'string'
    ? tokens.scope.split(/[ ,]/).filter(Boolean)
    : [...config.scopes];

  return { tokens, grantedScopes, rawTokenResponse: tokenData };
}

// ---------------------------------------------------------------------------
// Transport auto-detection
// ---------------------------------------------------------------------------

/**
 * Determine which callback transport to use when not explicitly specified.
 * Uses gateway if a public base URL is configured (ingress.publicBaseUrl or
 * INGRESS_PUBLIC_BASE_URL), otherwise loopback.
 */
function detectTransport(): 'loopback' | 'gateway' {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPublicBaseUrl } = require('../inbound/public-ingress-urls.js') as typeof import('../inbound/public-ingress-urls.js');
    const appConfig = loadConfig();
    getPublicBaseUrl(appConfig); // throws if no public URL configured
    return 'gateway';
  } catch {
    log.debug('No public base URL configured for transport auto-detection, defaulting to loopback');
  }
  return 'loopback';
}

// ---------------------------------------------------------------------------
// Loopback transport
// ---------------------------------------------------------------------------

async function runLoopbackFlow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  codeVerifier: string,
  codeChallenge: string,
  state: string,
): Promise<OAuth2FlowResult> {
  let resolveCode: (value: { code: string; returnedState: string }) => void;
  let rejectCode: (reason: Error) => void;

  const codePromise = new Promise<{ code: string; returnedState: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const FLOW_TIMEOUT_MS = 120_000;

  const timeout = setTimeout(() => {
    rejectCode(new Error('OAuth2 flow timed out waiting for user authorization'));
  }, FLOW_TIMEOUT_MS);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 });
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? error;
        rejectCode(new Error(`OAuth2 authorization denied: ${desc}`));
        return new Response(
          '<html><body><h2>Authorization denied</h2><p>You can close this tab.</p></body></html>',
          { headers: { 'Content-Type': 'text/html' } },
        );
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code || !returnedState) {
        rejectCode(new Error('OAuth2 callback missing code or state'));
        return new Response('Missing code or state', { status: 400 });
      }

      if (returnedState !== state) {
        rejectCode(new Error('OAuth2 state mismatch — possible CSRF attack'));
        return new Response('State mismatch', { status: 400 });
      }

      resolveCode({ code, returnedState });
      return new Response(
        '<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to Vellum.</p></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  try {
    const usePKCE = !config.clientSecret;
    const authParams = new URLSearchParams({
      ...config.extraParams,
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      state,
      ...(usePKCE ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
    });

    const authUrl = `${config.authUrl}?${authParams}`;
    callbacks.openUrl(authUrl);

    const { code, returnedState } = await codePromise;

    if (returnedState !== state) {
      throw new Error('OAuth2 state mismatch — possible CSRF attack');
    }

    return await exchangeCodeForTokens(config, code, redirectUri, codeVerifier);
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getOAuthCallbackUrl } = require('../inbound/public-ingress-urls.js') as typeof import('../inbound/public-ingress-urls.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registerPendingCallback } = require('./oauth-callback-registry.js') as typeof import('./oauth-callback-registry.js');

  const appConfig = loadConfig();
  const redirectUri = getOAuthCallbackUrl(appConfig);

  const codePromise = new Promise<string>((resolve, reject) => {
    registerPendingCallback(state, resolve, reject);
  });

  const usePKCE = !config.clientSecret;
  const authParams = new URLSearchParams({
    ...config.extraParams,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    ...(usePKCE ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
  });

  const authUrl = `${config.authUrl}?${authParams}`;
  callbacks.openUrl(authUrl);

  const code = await codePromise;

  return await exchangeCodeForTokens(config, code, redirectUri, codeVerifier);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full OAuth2 authorization code flow with PKCE support.
 *
 * Supports two callback transports:
 *   - loopback (default): local HTTP server on 127.0.0.1
 *   - gateway: callback via the gateway's OAuth route + in-memory registry
 *
 * Transport is auto-detected based on ingress.publicBaseUrl config unless
 * explicitly specified via options.callbackTransport.
 */
export async function startOAuth2Flow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  options?: OAuth2FlowOptions,
): Promise<OAuth2FlowResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // In gateway_only mode, enforce gateway transport and require a public ingress URL
  let ingressMode: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
    ingressMode = loadConfig().ingress.mode;
  } catch {
    // Fail closed: if config can't be loaded (e.g., malformed config.json), default to the
    // most restrictive mode to prevent loopback fallback from creating a fail-open path.
    log.warn('Failed to load config for OAuth ingress mode detection; defaulting to gateway_only (fail closed)');
    ingressMode = 'gateway_only';
  }

  if (ingressMode === 'gateway_only') {
    // Verify a public ingress URL is configured; fail fast with actionable error if not
    let hasPublicUrl = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getPublicBaseUrl } = require('../inbound/public-ingress-urls.js') as typeof import('../inbound/public-ingress-urls.js');
      getPublicBaseUrl(loadConfig());
      hasPublicUrl = true;
    } catch {
      // No public URL configured
    }

    if (!hasPublicUrl) {
      throw new Error(
        'OAuth requires a public ingress URL in gateway-only mode. Set ingress.publicBaseUrl or INGRESS_PUBLIC_BASE_URL so OAuth callbacks can route through the gateway.',
      );
    }

    // In gateway_only mode, always use gateway transport — never fall back to loopback
    log.debug({ transport: 'gateway' }, 'OAuth2 flow starting (gateway_only mode)');
    return runGatewayFlow(config, callbacks, codeVerifier, codeChallenge, state);
  }

  const transport = options?.callbackTransport ?? detectTransport();
  log.debug({ transport }, 'OAuth2 flow starting');

  if (transport === 'gateway') {
    return runGatewayFlow(config, callbacks, codeVerifier, codeChallenge, state);
  }

  return runLoopbackFlow(config, callbacks, codeVerifier, codeChallenge, state);
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
): Promise<OAuth2TokenResult> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  };
  if (clientSecret) {
    body.client_secret = clientSecret;
  }

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

  if (!resp.ok) {
    const rawBody = await resp.text().catch(() => '');
    const safeDetail: Record<string, unknown> = {};
    let errorCode = '';
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.error) { safeDetail.error = String(parsed.error); errorCode = String(parsed.error); }
      if (parsed.error_description) safeDetail.error_description = String(parsed.error_description);
    } catch {
      safeDetail.error = '[non-JSON response]';
    }
    log.error({ status: resp.status, ...safeDetail }, 'OAuth2 token refresh failed');
    const detail = errorCode ? `HTTP ${resp.status}: ${errorCode}` : `HTTP ${resp.status}`;
    throw new Error(`OAuth2 token refresh failed (${detail})`);
  }

  const data = await resp.json() as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
    expiresIn: data.expires_in as number | undefined,
    scope: data.scope as string | undefined,
    tokenType: data.token_type as string | undefined,
  };
}

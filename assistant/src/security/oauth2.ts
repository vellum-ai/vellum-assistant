/**
 * General-purpose OAuth2 Authorization Code flow with PKCE.
 *
 * Uses the gateway callback transport: OAuth callbacks route through the
 * gateway's OAuth callback route + in-memory registry (requires
 * ingress.publicBaseUrl to be configured).
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

export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post';

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
   * Defaults to `client_secret_post` for backward compatibility.
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
  const authMethod = config.tokenEndpointAuthMethod ?? 'client_secret_post';

  const tokenBody: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (config.clientSecret && authMethod === 'client_secret_basic') {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else {
    tokenBody.client_id = config.clientId;
    if (config.clientSecret) {
      tokenBody.client_secret = config.clientSecret;
    }
  }

  const tokenResp = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
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
// Gateway transport
// ---------------------------------------------------------------------------

async function runGatewayFlow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  codeVerifier: string,
  codeChallenge: string,
  state: string,
): Promise<OAuth2FlowResult> {
  const { loadConfig } = await import('../config/loader.js');
  const { getOAuthCallbackUrl } = await import('../inbound/public-ingress-urls.js');
  const { registerPendingCallback } = await import('./oauth-callback-registry.js');

  const appConfig = loadConfig();
  const redirectUri = getOAuthCallbackUrl(appConfig);

  const codePromise = new Promise<string>((resolve, reject) => {
    registerPendingCallback(state, resolve, reject);
  });

  const authParams = new URLSearchParams({
    ...config.extraParams,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
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
 * Uses the gateway callback transport, which routes OAuth callbacks through
 * the gateway's OAuth route + in-memory registry. Requires a public ingress
 * URL to be configured.
 */
export async function startOAuth2Flow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
  _options?: OAuth2FlowOptions,
): Promise<OAuth2FlowResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Always enforce gateway transport and require a public ingress URL
  let hasPublicUrl = false;
  try {
    const { loadConfig } = await import('../config/loader.js');
    const { getPublicBaseUrl } = await import('../inbound/public-ingress-urls.js');
    getPublicBaseUrl(loadConfig());
    hasPublicUrl = true;
  } catch {
    // No public URL configured
  }

  if (!hasPublicUrl) {
    throw new Error(
      'OAuth requires a public ingress URL. Set ingress.publicBaseUrl or INGRESS_PUBLIC_BASE_URL so OAuth callbacks can route through the gateway.',
    );
  }

  // Always use gateway transport — never fall back to loopback
  log.debug({ transport: 'gateway' }, 'OAuth2 flow starting');
  return runGatewayFlow(config, callbacks, codeVerifier, codeChallenge, state);
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
  const authMethod = tokenEndpointAuthMethod ?? 'client_secret_post';

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (clientSecret && authMethod === 'client_secret_basic') {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else {
    body.client_id = clientId;
    if (clientSecret) {
      body.client_secret = clientSecret;
    }
  }

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers,
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

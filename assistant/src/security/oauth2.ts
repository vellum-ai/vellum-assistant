/**
 * General-purpose OAuth2 Authorization Code flow with PKCE.
 *
 * Moved from integrations/oauth2.ts. Types that were in integrations/types.ts
 * are now inlined here since the integration framework is removed.
 */

import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuth2Config {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
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

export interface OAuth2FlowResult {
  tokens: OAuth2TokenResult;
  grantedScopes: string[];
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full OAuth2 PKCE authorization code flow using a loopback redirect.
 */
export async function startOAuth2Flow(
  config: OAuth2Config,
  callbacks: OAuth2FlowCallbacks,
): Promise<OAuth2FlowResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  let resolveCode: (value: { code: string; returnedState: string }) => void;
  let rejectCode: (reason: Error) => void;

  const codePromise = new Promise<{ code: string; returnedState: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  /** How long to wait for the user to complete the OAuth consent flow. */
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

    const { code, returnedState } = await codePromise;

    if (returnedState !== state) {
      throw new Error('OAuth2 state mismatch — possible CSRF attack');
    }

    const tokenResp = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResp.ok) {
      const body = await tokenResp.text().catch(() => '');
      throw new Error(`OAuth2 token exchange failed (${tokenResp.status}): ${body}`);
    }

    const tokenData = await tokenResp.json() as Record<string, unknown>;

    const tokens: OAuth2TokenResult = {
      accessToken: tokenData.access_token as string,
      refreshToken: tokenData.refresh_token as string | undefined,
      expiresIn: tokenData.expires_in as number | undefined,
      scope: tokenData.scope as string | undefined,
      tokenType: tokenData.token_type as string | undefined,
    };

    const grantedScopes = typeof tokens.scope === 'string'
      ? tokens.scope.split(' ').filter(Boolean)
      : [...config.scopes];

    return { tokens, grantedScopes };
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }
}

/**
 * Refresh an OAuth2 access token using a refresh token (PKCE, no secret required).
 */
export async function refreshOAuth2Token(
  tokenUrl: string,
  clientId: string,
  refreshToken: string,
): Promise<OAuth2TokenResult> {
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OAuth2 token refresh failed (${resp.status}): ${body}`);
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

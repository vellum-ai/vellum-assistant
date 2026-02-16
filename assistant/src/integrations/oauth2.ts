/**
 * OAuth2 PKCE loopback flow for desktop integrations.
 *
 * 1. Generate code_verifier + code_challenge (S256)
 * 2. Start a temporary HTTP server on a random port
 * 3. Open the browser to the authorization URL
 * 4. Wait for the callback with the auth code
 * 5. Exchange the code for tokens (PKCE, no secret required)
 * 6. Return the token result
 */

import { randomBytes, createHash } from 'node:crypto';
import type { OAuth2Config, OAuth2TokenResult } from './types.js';

/** How long to wait for the user to complete the OAuth consent flow. */
const FLOW_TIMEOUT_MS = 120_000;

export interface OAuth2FlowCallbacks {
  /** Open a URL in the user's browser (e.g. via IPC `open_url`). */
  openUrl: (url: string) => void;
}

export interface OAuth2FlowResult {
  tokens: OAuth2TokenResult;
  grantedScopes: string[];
}

function generateCodeVerifier(): string {
  // RFC 7636: 43-128 unreserved characters
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Run a full OAuth2 PKCE authorization code flow using a loopback redirect.
 *
 * Starts a temporary HTTP server on 127.0.0.1 (required by Google for desktop
 * apps), opens the authorization URL in the browser, waits for the callback,
 * exchanges the code for tokens, and returns the result.
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

  const timeout = setTimeout(() => {
    rejectCode(new Error('OAuth2 flow timed out waiting for user authorization'));
  }, FLOW_TIMEOUT_MS);

  // Start temporary HTTP server on a random port
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // random available port
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

      resolveCode({ code, returnedState });
      return new Response(
        '<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to Vellum.</p></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  try {
    // Build authorization URL
    const authParams = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...config.extraParams,
    });

    const authUrl = `${config.authUrl}?${authParams}`;
    callbacks.openUrl(authUrl);

    // Wait for the callback
    const { code, returnedState } = await codePromise;

    if (returnedState !== state) {
      throw new Error('OAuth2 state mismatch — possible CSRF attack');
    }

    // Exchange code for tokens (PKCE — no secret required)
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

    // Parse granted scopes from the response
    const grantedScopes = typeof tokens.scope === 'string'
      ? tokens.scope.split(' ').filter(Boolean)
      : [...config.scopes]; // assume all requested if not returned

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
    refreshToken: data.refresh_token as string | undefined,
    expiresIn: data.expires_in as number | undefined,
    scope: data.scope as string | undefined,
    tokenType: data.token_type as string | undefined,
  };
}

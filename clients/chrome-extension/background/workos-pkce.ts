/**
 * App-held PKCE login against WorkOS User Management for the Chrome extension.
 * Mirrors Electron + CLI implementations, with two adaptations for the
 * extension service worker:
 *   - PKCE hashing uses Web Crypto (`crypto.subtle`), not Node's `crypto`.
 *   - The redirect is captured by `chrome.identity.launchWebAuthFlow`,
 *     not a loopback HTTP server.
 */

const WORKOS_API_BASE_URL = 'https://api.workos.com';
const PROVIDER_ID = 'workos';
const SCOPE = 'openid profile email';

// ── PKCE ────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 PKCE pair via Web Crypto */
export async function generatePkcePair(): Promise<PkcePair> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  const challenge = base64UrlEncode(new Uint8Array(digest));

  return { verifier, challenge };
}

/** Generate a random URL-safe state token for CSRF protection. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// ── Authorize URL ───────────────────────────────────────────────────

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  loginHint?: string;
  providerHint?: string;
  intent?: string;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL('/user_management/authorize', WORKOS_API_BASE_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);
  // No `prompt`: lets the browser's existing IdP session be reused.
  url.searchParams.set('provider', options.providerHint || 'authkit');
  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
  if (options.intent === 'signup') url.searchParams.set('screen_hint', 'sign-up');
  return url.toString();
}

// ── Redirect parsing ────────────────────────────────────────────────

export interface ParsedRedirect {
  code: string;
  state: string;
}

export function parseRedirectUrl(
  redirectUrl: string,
  expectedState: string,
): ParsedRedirect {
  const url = new URL(redirectUrl);
  // WorkOS returns params in the query string of the redirect URL.
  const params = url.searchParams;

  const error = params.get('error');
  if (error) {
    const description = params.get('error_description') ?? error;
    throw new Error(`Authentication failed: ${description}`);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code) {
    throw new Error('Authentication failed: no authorization code received.');
  }
  if (!state || state !== expectedState) {
    throw new Error('Authentication failed: state mismatch (possible CSRF).');
  }

  return { code, state };
}

// ── Headless config discovery ───────────────────────────────────────

export interface HeadlessProviderEntry {
  id: string;
  name?: string;
  client_id?: string;
  flows?: string[];
  openid_configuration_url?: string;
}

/**
 * Pick the OAuth2 WorkOS provider from the headless config. During the
 * coexistence window two entries share the "workos-oidc" id; the usable one
 * has token auth and no OIDC discovery URL. Null if none.
 */
export function selectWorkosClientId(
  providers: HeadlessProviderEntry[],
): string | null {
  const entry = providers.find(
    (p) =>
      !p.openid_configuration_url &&
      (p.flows ?? []).includes('provider_token') &&
      typeof p.client_id === 'string',
  );
  return entry?.client_id ?? null;
}

export async function fetchWorkosClientId(platformUrl: string): Promise<string> {
  const url = `${new URL(platformUrl).origin}/_allauth/app/v1/config`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Failed to fetch auth config (${response.status}).`);
  }
  const body = (await response.json()) as {
    data?: { socialaccount?: { providers?: HeadlessProviderEntry[] } };
  };
  const clientId = selectWorkosClientId(
    body.data?.socialaccount?.providers ?? [],
  );
  if (!clientId) {
    throw new Error(
      'Platform does not advertise a token-auth WorkOS provider; cannot start PKCE login.',
    );
  }
  return clientId;
}

// ── Code exchange (WorkOS, public client) ───────────────────────────

/** Exchange the authorization code at WorkOS as a public client. */
export async function exchangeCodeWithWorkos(options: {
  clientId: string;
  code: string;
  verifier: string;
}): Promise<string> {
  const response = await fetch(
    `${WORKOS_API_BASE_URL}/user_management/authenticate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: options.clientId,
        grant_type: 'authorization_code',
        code: options.code,
        code_verifier: options.verifier,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`WorkOS code exchange failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('WorkOS code exchange returned no access token.');
  }
  return data.access_token;
}

// ── Session exchange (platform allauth headless token endpoint) ─────

export interface SessionExchangeResult {
  /** Platform session token. */
  sessionToken: string;
  /** The user's email, if the platform returned it. */
  email?: string;
}

/** Exchange the WorkOS access token for a platform session token (+ email if present). */
export async function exchangeAccessTokenForSession(
  platformUrl: string,
  clientId: string,
  accessToken: string,
): Promise<SessionExchangeResult> {
  const url = `${new URL(platformUrl).origin}/_allauth/app/v1/auth/provider/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      provider: PROVIDER_ID,
      process: 'login',
      token: { client_id: clientId, access_token: accessToken },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Session exchange failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as {
    meta?: { session_token?: string };
    data?: { user?: { email?: string } };
  };
  if (!data.meta?.session_token) {
    throw new Error('Session exchange returned no session token.');
  }
  return {
    sessionToken: data.meta.session_token,
    email: data.data?.user?.email,
  };
}

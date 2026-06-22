/**
 * Tests for the WorkOS app-held PKCE helpers used by the Chrome extension's
 * cloud login flow.
 *
 * Covers the pure / transport-agnostic surface:
 *   - generatePkcePair: format + S256 challenge correctness
 *   - generateState: format + uniqueness
 *   - buildAuthorizeUrl: WorkOS authorize URL contract
 *   - parseRedirectUrl: code/state extraction, error + CSRF handling
 *   - selectWorkosClientId: coexistence-window provider selection
 */

import { describe, test, expect } from 'bun:test';

import {
  generatePkcePair,
  generateState,
  buildAuthorizeUrl,
  parseRedirectUrl,
  selectWorkosClientId,
  type HeadlessProviderEntry,
} from '../workos-pkce.js';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// ── generatePkcePair ────────────────────────────────────────────────

describe('generatePkcePair', () => {
  test('verifier is 32 random bytes base64url-encoded (no padding)', async () => {
    const { verifier } = await generatePkcePair();
    expect(verifier).toMatch(BASE64URL_RE);
    // 32 bytes base64url → 43 chars, no padding.
    expect(verifier.length).toBe(43);
    expect(verifier).not.toContain('=');
    expect(verifier).not.toContain('+');
    expect(verifier).not.toContain('/');
  });

  test('challenge is base64url(sha256(verifier))', async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(challenge).toMatch(BASE64URL_RE);
    // SHA-256 digest is 32 bytes → 43 chars base64url, no padding.
    expect(challenge.length).toBe(43);

    // Recompute the expected challenge from the verifier and compare.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier),
    );
    const bytes = new Uint8Array(digest);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const expected = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  test('produces a different pair each call', async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

// ── generateState ───────────────────────────────────────────────────

describe('generateState', () => {
  test('is a non-empty base64url string', () => {
    const state = generateState();
    expect(state).toMatch(BASE64URL_RE);
    expect(state.length).toBeGreaterThan(0);
  });

  test('is unique across calls', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

// ── buildAuthorizeUrl ───────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  const baseOptions = {
    clientId: 'client_abc123',
    redirectUri: 'https://ext-id.chromiumapp.org/cloud-auth',
    challenge: 'challenge-value',
    state: 'state-value',
  };

  test('targets the WorkOS user_management authorize endpoint', () => {
    const url = new URL(buildAuthorizeUrl(baseOptions));
    expect(url.origin).toBe('https://api.workos.com');
    expect(url.pathname).toBe('/user_management/authorize');
  });

  test('sets the required PKCE + OAuth params', () => {
    const url = new URL(buildAuthorizeUrl(baseOptions));
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('client_abc123');
    expect(p.get('redirect_uri')).toBe(
      'https://ext-id.chromiumapp.org/cloud-auth',
    );
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('openid profile email');
    expect(p.get('code_challenge')).toBe('challenge-value');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('state-value');
    expect(p.get('provider')).toBe('authkit');
  });

  test('does not set a prompt param (reuse existing IdP session)', () => {
    const url = new URL(buildAuthorizeUrl(baseOptions));
    expect(url.searchParams.has('prompt')).toBe(false);
  });

  test('omits login_hint and screen_hint by default', () => {
    const url = new URL(buildAuthorizeUrl(baseOptions));
    expect(url.searchParams.has('login_hint')).toBe(false);
    expect(url.searchParams.has('screen_hint')).toBe(false);
  });

  test('passes login_hint and signup screen_hint when provided', () => {
    const url = new URL(
      buildAuthorizeUrl({
        ...baseOptions,
        loginHint: 'user@example.com',
        intent: 'signup',
      }),
    );
    expect(url.searchParams.get('login_hint')).toBe('user@example.com');
    expect(url.searchParams.get('screen_hint')).toBe('sign-up');
  });

  test('honors a custom provider hint', () => {
    const url = new URL(
      buildAuthorizeUrl({ ...baseOptions, providerHint: 'GoogleOAuth' }),
    );
    expect(url.searchParams.get('provider')).toBe('GoogleOAuth');
  });
});

// ── parseRedirectUrl ────────────────────────────────────────────────

describe('parseRedirectUrl', () => {
  test('extracts code + state from a matching redirect', () => {
    const result = parseRedirectUrl(
      'https://ext-id.chromiumapp.org/cloud-auth?code=abc&state=xyz',
      'xyz',
    );
    expect(result).toEqual({ code: 'abc', state: 'xyz' });
  });

  test('throws on a WorkOS error param with description', () => {
    expect(() =>
      parseRedirectUrl(
        'https://ext-id.chromiumapp.org/cloud-auth?error=access_denied&error_description=User+declined',
        'xyz',
      ),
    ).toThrow('User declined');
  });

  test('throws on a WorkOS error param without description', () => {
    expect(() =>
      parseRedirectUrl(
        'https://ext-id.chromiumapp.org/cloud-auth?error=server_error',
        'xyz',
      ),
    ).toThrow('server_error');
  });

  test('throws when no code is present', () => {
    expect(() =>
      parseRedirectUrl(
        'https://ext-id.chromiumapp.org/cloud-auth?state=xyz',
        'xyz',
      ),
    ).toThrow('no authorization code');
  });

  test('throws on a state mismatch (CSRF)', () => {
    expect(() =>
      parseRedirectUrl(
        'https://ext-id.chromiumapp.org/cloud-auth?code=abc&state=wrong',
        'xyz',
      ),
    ).toThrow('state mismatch');
  });

  test('throws when state is missing entirely', () => {
    expect(() =>
      parseRedirectUrl(
        'https://ext-id.chromiumapp.org/cloud-auth?code=abc',
        'xyz',
      ),
    ).toThrow('state mismatch');
  });
});

// ── selectWorkosClientId ────────────────────────────────────────────

describe('selectWorkosClientId', () => {
  test('returns null when no providers are advertised', () => {
    expect(selectWorkosClientId([])).toBeNull();
  });

  test('picks the OAuth2 (no OIDC discovery URL) provider during coexistence', () => {
    // Two entries share the same id; the OIDC one has a discovery URL and must
    // be skipped in favor of the OAuth2 one.
    const providers: HeadlessProviderEntry[] = [
      {
        id: 'workos-oidc',
        client_id: 'client_oidc',
        flows: ['provider_token'],
        openid_configuration_url: 'https://api.workos.com/.well-known/openid',
      },
      {
        id: 'workos-oidc',
        client_id: 'client_oauth2',
        flows: ['provider_token'],
      },
    ];
    expect(selectWorkosClientId(providers)).toBe('client_oauth2');
  });

  test('requires the provider_token flow', () => {
    const providers: HeadlessProviderEntry[] = [
      { id: 'workos-oidc', client_id: 'client_x', flows: ['authorization_code'] },
    ];
    expect(selectWorkosClientId(providers)).toBeNull();
  });

  test('requires a client_id string', () => {
    const providers: HeadlessProviderEntry[] = [
      { id: 'workos-oidc', flows: ['provider_token'] },
    ];
    expect(selectWorkosClientId(providers)).toBeNull();
  });

  test('returns the single valid OAuth2 provider', () => {
    const providers: HeadlessProviderEntry[] = [
      { id: 'workos-oidc', client_id: 'client_only', flows: ['provider_token'] },
    ];
    expect(selectWorkosClientId(providers)).toBe('client_only');
  });
});

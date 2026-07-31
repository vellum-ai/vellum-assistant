/**
 * App-held PKCE login against WorkOS User Management (RFC 8252 loopback).
 */

import crypto from "node:crypto";

import { loopbackSafeFetch } from "./loopback-fetch.js";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const PROVIDER_ID = "workos";
const SCOPE = "openid profile email";

// Use a loopback callback: `http://127.0.0.1:*/auth/callback`
export const CALLBACK_PATH = "/auth/callback";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  loginHint?: string;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL("/user_management/authorize", WORKOS_API_BASE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  // No `prompt`: lets the browser's existing IdP session be reused.
  url.searchParams.set("provider", "authkit");
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url.toString();
}

interface HeadlessProviderEntry {
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
      (p.flows ?? []).includes("provider_token") &&
      typeof p.client_id === "string",
  );
  return entry?.client_id ?? null;
}

export async function fetchWorkosClientId(
  platformUrl: string,
): Promise<string> {
  const url = `${new URL(platformUrl).origin}/_allauth/app/v1/config`;
  const response = await loopbackSafeFetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch auth config (${response.status})`);
  }
  const body = (await response.json()) as {
    data?: { socialaccount?: { providers?: HeadlessProviderEntry[] } };
  };
  const clientId = selectWorkosClientId(
    body.data?.socialaccount?.providers ?? [],
  );
  if (!clientId) {
    throw new Error(
      "Platform does not advertise a token-auth WorkOS provider; cannot start PKCE login.",
    );
  }
  return clientId;
}

/** Exchange the authorization code at WorkOS as a public client. */
export async function exchangeCodeWithWorkos(options: {
  clientId: string;
  code: string;
  verifier: string;
}): Promise<string> {
  const response = await loopbackSafeFetch(
    `${WORKOS_API_BASE_URL}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: options.clientId,
        grant_type: "authorization_code",
        code: options.code,
        code_verifier: options.verifier,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `WorkOS code exchange failed (${response.status}): ${body}`,
    );
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("WorkOS code exchange returned no access token.");
  }
  return data.access_token;
}

/** Exchange the WorkOS access token for a platform session token. */
export async function exchangeAccessTokenForSession(
  platformUrl: string,
  clientId: string,
  accessToken: string,
): Promise<string> {
  const url = `${new URL(platformUrl).origin}/_allauth/app/v1/auth/provider/token`;
  const response = await loopbackSafeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: PROVIDER_ID,
      process: "login",
      token: { client_id: clientId, access_token: accessToken },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session exchange failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as {
    meta?: { session_token?: string };
  };
  if (!data.meta?.session_token) {
    throw new Error("Session exchange returned no session token.");
  }
  return data.meta.session_token;
}

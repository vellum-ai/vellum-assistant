/**
 * App-held PKCE login against WorkOS User Management (RFC 8252 loopback):
 * authorize in the system browser, receive the code on an ephemeral
 * 127.0.0.1 listener, exchange it as a public client, then swap the access
 * token for a platform session token via allauth's headless token endpoint.
 */

import { net } from "electron";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const PROVIDER_ID = "workos";
const SCOPE = "openid profile email";

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
  providerHint?: string;
  intent?: string;
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
  url.searchParams.set("provider", options.providerHint || "authkit");
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  if (options.intent === "signup") url.searchParams.set("screen_hint", "sign-up");
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
 * Pick the first-class WorkOS OAuth2 provider out of the headless config.
 *
 * During the coexistence window the platform lists two entries
 * with the same "workos-oidc" provider ID.
 * The OAuth2 one is distinguished by having no OIDC discovery URL.
 * Returns null when the platform doesn't support token auth yet - 
 * callers should surface that as a clear error.
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

export async function fetchWorkosClientId(platformUrl: string): Promise<string> {
  const url = `${new URL(platformUrl).origin}/_allauth/app/v1/config`;
  const response = await net.fetch(url);
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

// Mirrors the native apps' legacy deep-link path ({scheme}://auth/callback).
const CALLBACK_PATH = "/auth/callback";

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Signed in — you can close this tab and return to Vellum.</p></body></html>`;

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Sign-in failed — you can close this tab and try again from Vellum.</p></body></html>`;

export interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once the browser hits the callback. */
  waitForCode: Promise<string>;
  close: (reason?: string) => void;
}

/** Bind an ephemeral loopback listener and wait for the OAuth redirect. */
export function startLoopbackListener(expectedState: string): Promise<LoopbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle: { resolve: (code: string) => void; reject: (err: Error) => void };
    const waitForCode = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH || url.searchParams.get("state") !== expectedState) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        res.writeHead(200, { "Content-Type": "text/html" }).end(ERROR_HTML);
        settle.reject(
          new Error(`Authentication failed: ${error ?? "no authorization code received"}`),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
      settle.resolve(code);
    });

    server.on("error", rejectListener);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveListener({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        waitForCode,
        close: (reason?: string) => {
          server.close();
          settle.reject(new Error(reason ?? "Auth flow cancelled."));
        },
      });
    });
  });
}

/** Exchange the authorization code at WorkOS as a public client. */
export async function exchangeCodeWithWorkos(options: {
  clientId: string;
  code: string;
  verifier: string;
}): Promise<string> {
  const response = await net.fetch(
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
    throw new Error(`WorkOS code exchange failed (${response.status}): ${body}`);
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
  const response = await net.fetch(url, {
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

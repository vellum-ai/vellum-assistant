/**
 * Server-held WorkOS PKCE login for `vellum client --interface web`: the SPA
 * POSTs `/__local/login/start` and navigates to the returned authorize URL;
 * WorkOS redirects to GET `/auth/callback` here, which exchanges the code and
 * installs the session token. The state nonce is the CSRF defense (any local
 * process can hit the port) — absent/mismatched/expired/replayed → 404.
 */

import crypto from "node:crypto";

import {
  CALLBACK_PATH,
  buildAuthorizeUrl,
  exchangeAccessTokenForSession,
  exchangeCodeWithWorkos,
  fetchWorkosClientId,
  generatePkcePair,
} from "./workos-pkce";

/** Matches `vellum login`'s 2-minute browser timeout. */
const PENDING_LOGIN_TTL_MS = 120_000;

const DEFAULT_RETURN_TO = "/assistant/";

interface PendingLogin {
  state: string;
  verifier: string;
  clientId: string;
  returnTo: string;
  expiresAt: number;
}

export interface WebLoginFlowOptions {
  platformUrl: string;
  /** Persist and cache the exchanged session token. */
  installToken: (token: string) => void;
  /** Whether the logged-in user already has platform assistants. */
  hasAssistants?: (token: string) => Promise<boolean>;
}

/**
 * Server-side returnTo sanitization: relative paths only. Rejects absolute
 * URLs, protocol-relative `//`, and backslash open-redirect variants.
 */
export function sanitizeLoginReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/")) {
    return DEFAULT_RETURN_TO;
  }
  if (value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_RETURN_TO;
  }
  return value;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loginErrorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  return new Response(
    `<!doctype html><html><body><p>Login failed: ${escapeHtml(message)}</p>` +
      `<p>Close this tab and try again.</p></body></html>`,
    { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export interface WebLoginFlow {
  /** POST /__local/login/start — returns `{ authorizeUrl }`. */
  handleStart(url: URL): Promise<Response>;
  /** GET /auth/callback — exchanges the code and 302s back into the SPA. */
  handleCallback(url: URL): Promise<Response>;
}

export function createWebLoginFlow(options: WebLoginFlowOptions): WebLoginFlow {
  // Single pending login; a new start supersedes the previous one.
  let pending: PendingLogin | null = null;

  async function handleStart(url: URL): Promise<Response> {
    const returnTo = sanitizeLoginReturnTo(url.searchParams.get("returnTo"));
    const intent = url.searchParams.get("intent") ?? undefined;

    let clientId: string;
    try {
      clientId = await fetchWorkosClientId(options.platformUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 502 });
    }

    const { verifier, challenge } = generatePkcePair();
    const state = crypto.randomBytes(32).toString("hex");
    pending = {
      state,
      verifier,
      clientId,
      returnTo,
      expiresAt: Date.now() + PENDING_LOGIN_TTL_MS,
    };

    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      // Registered WorkOS redirect URI: http://127.0.0.1:*/auth/callback.
      redirectUri: `http://127.0.0.1:${url.port}${CALLBACK_PATH}`,
      challenge,
      state,
      intent,
    });
    return Response.json({ authorizeUrl });
  }

  async function handleCallback(url: URL): Promise<Response> {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const current = pending;
    if (
      !current ||
      !state ||
      !code ||
      state !== current.state ||
      Date.now() > current.expiresAt
    ) {
      return new Response("Not Found", { status: 404 });
    }
    // Single-use: clear before the network legs to block replays.
    pending = null;

    let token: string;
    try {
      const accessToken = await exchangeCodeWithWorkos({
        clientId: current.clientId,
        code,
        verifier: current.verifier,
      });
      token = await exchangeAccessTokenForSession(
        options.platformUrl,
        current.clientId,
        accessToken,
      );
      options.installToken(token);
    } catch (err) {
      return loginErrorResponse(err);
    }

    // Existing-assistant users land in the app, not back at returnTo (which
    // is typically onboarding). Mirrors the deleted loopback page's routing.
    let destination = current.returnTo;
    try {
      if (await options.hasAssistants?.(token)) {
        destination = DEFAULT_RETURN_TO;
      }
    } catch {
      // Can't tell — honor returnTo.
    }

    // Back to the origin the user started on (`localhost`, not `127.0.0.1`).
    return new Response(null, {
      status: 302,
      headers: { Location: `http://localhost:${url.port}${destination}` },
    });
  }

  return { handleStart, handleCallback };
}

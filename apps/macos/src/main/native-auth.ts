import { net, session, shell } from "electron";
import crypto from "node:crypto";
import { z } from "zod";

import { resolveLocalConfigFromEnv } from "@vellumai/local-mode";

import { handle, handleSync } from "./ipc";
import {
    clearSessionToken,
    getSessionToken,
    saveSessionToken,
} from "./session-token-store";
import {
    buildAuthorizeUrl,
    exchangeAccessTokenForSession,
    exchangeCodeWithWorkos,
    fetchWorkosClientId,
    generatePkcePair,
    startLoopbackListener,
} from "./workos-pkce";

const AUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

interface PendingFlow {
  resolve: (sessionToken: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingFlows = new Map<string, PendingFlow>();

export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function buildStartUrl(
  platformUrl: string,
  state: string,
  options: {
    providerHint?: string;
    loginHint?: string;
    clientVersion?: string;
  },
): string {
  const url = new URL("/accounts/native/start", platformUrl);
  url.searchParams.set("state", state);
  if (options.providerHint) url.searchParams.set("provider_hint", options.providerHint);
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  if (options.clientVersion) url.searchParams.set("client_version", options.clientVersion);
  return url.toString();
}

async function exchangeCode(
  platformUrl: string,
  code: string,
): Promise<string> {
  const url = `${new URL(platformUrl).origin}/accounts/native/exchange`;
  const response = await net.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Code exchange failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { session_token: string };
  return data.session_token;
}

// Evict the session cookies installed by prior builds, so that
// header auth takes precedence.
async function clearLegacySessionCookies(): Promise<void> {
  const url = resolveProxyPlatformUrl();
  await Promise.all(
    ["sessionid", "__Secure-sessionid"].map((name) =>
      // Best-effort — a missing cookie is the common case.
      session.defaultSession.cookies.remove(url, name).catch(() => undefined),
    ),
  );
}

function cancelPendingFlows(): void {
  for (const flow of pendingFlows.values()) {
    clearTimeout(flow.timer);
    flow.reject(new Error("Auth flow cancelled — a new flow was started."));
  }
  pendingFlows.clear();
}

// The OAuth start/exchange endpoints must go through the web origin (not
// the platform origin) because WorkOS redirect URIs are registered against
// the web domain (e.g. dev-assistant.vellum.ai, localhost:3000). The web
// server proxies /accounts/* to Django, so Django sees the web host and
// builds a matching callback URL.
function resolveAuthPlatformUrl(): string {
  return resolveLocalConfigFromEnv(process.env).webUrl;
}

// The platform URL the renderer's proxy talks to.
function resolveProxyPlatformUrl(): string {
  return resolveLocalConfigFromEnv(process.env).platformUrl;
}

let activePkceCancel: ((reason?: string) => void) | null = null;

/**
 * App-held PKCE login (workos-pkce.ts). Replaces the server-mediated flow
 * (`/accounts/native/start` → deep link → `/accounts/native/exchange`);
 * older builds keep using those legacy endpoints.
 */
async function startOAuth(options: {
  providerHint?: string;
  loginHint?: string;
  intent?: string;
}): Promise<{ sessionToken: string }> {
  cancelPendingFlows();
  activePkceCancel?.();

  const platformUrl = resolveProxyPlatformUrl();
  const clientId = await fetchWorkosClientId(platformUrl);
  const state = generateState();
  const { verifier, challenge } = generatePkcePair();
  const listener = await startLoopbackListener(state);

  const timer = setTimeout(
    () => listener.close("Sign-in timed out. Please try again."),
    AUTH_FLOW_TIMEOUT_MS,
  );
  activePkceCancel = listener.close;

  try {
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri: listener.redirectUri,
      challenge,
      state,
      loginHint: options.loginHint,
      providerHint: options.providerHint,
      intent: options.intent,
    });
    void shell.openExternal(authorizeUrl);

    const code = await listener.waitForCode;
    const accessToken = await exchangeCodeWithWorkos({
      clientId,
      code,
      verifier,
    });
    const sessionToken = await exchangeAccessTokenForSession(
      platformUrl,
      clientId,
      accessToken,
    );

    saveSessionToken(sessionToken);
    return { sessionToken };
  } finally {
    clearTimeout(timer);
    listener.close();
    activePkceCancel = null;
  }
}

export async function handleAuthCallback(
  state: string,
  code?: string,
  error?: string,
): Promise<void> {
  const flow = pendingFlows.get(state);
  if (!flow) return;

  pendingFlows.delete(state);
  clearTimeout(flow.timer);

  if (error) {
    flow.reject(new Error(`Authentication failed: ${error}`));
    return;
  }

  if (!code) {
    flow.reject(new Error("Authentication failed: no authorization code received."));
    return;
  }

  try {
    const sessionToken = await exchangeCode(resolveAuthPlatformUrl(), code);
    flow.resolve(sessionToken);
  } catch (err) {
    flow.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

const startOAuthSchema = z.tuple([
  z.object({
    providerHint: z.string().optional(),
    loginHint: z.string().optional(),
    intent: z.string().optional(),
  }),
]);

let installed = false;

export const installNativeAuth = (): void => {
  if (installed) return;
  installed = true;

  void clearLegacySessionCookies();

  handle(
    "vellum:auth:startOAuth",
    startOAuthSchema,
    async ([options]): Promise<{ sessionToken: string }> => {
      return startOAuth(options);
    },
  );

  handle("vellum:auth:cancelOAuth", z.tuple([]), () => {
    cancelPendingFlows();
    activePkceCancel?.();
  });

  handle("vellum:auth:signOut", z.tuple([]), () => {
    clearSessionToken();
  });

  handleSync("vellum:auth:getSessionToken", () => getSessionToken());
};

export const __resetForTesting = (): void => {
  installed = false;
  cancelPendingFlows();
};

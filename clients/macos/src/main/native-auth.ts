import { session, shell } from "electron";
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

export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
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

// The platform URL the renderer's proxy talks to.
function resolveProxyPlatformUrl(): string {
  return resolveLocalConfigFromEnv(process.env).platformUrl;
}

let activePkceCancel: ((reason?: string) => void) | null = null;

/**
 * App-held PKCE login (workos-pkce.ts). Drives the WorkOS OAuth flow in
 * the main process; the renderer is uninvolved beyond the IPC result.
 */
async function startOAuth(options: {
  providerHint?: string;
  loginHint?: string;
  intent?: string;
}): Promise<{ sessionToken: string }> {
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
    activePkceCancel?.();
  });

  handle("vellum:auth:signOut", z.tuple([]), () => {
    clearSessionToken();
  });

  handleSync("vellum:auth:getSessionToken", () => getSessionToken());
};

export const __resetForTesting = (): void => {
  installed = false;
  activePkceCancel?.();
};

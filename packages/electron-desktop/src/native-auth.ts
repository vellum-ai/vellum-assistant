import crypto from "node:crypto";
import { z } from "zod";

import type { createIpcRegistrar } from "./ipc";
import type {
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

type IpcRegistrar = Pick<
  ReturnType<typeof createIpcRegistrar>,
  "handle" | "handleSync"
>;

export interface NativeAuthCallback {
  redirectUri: string;
  waitForCode: Promise<string>;
  close: (reason?: string) => void;
}

export interface NativeAuthOptions {
  activateWindow: () => void | Promise<void>;
  getPlatformUrl: () => string;
  ipc: IpcRegistrar;
  openExternal: (url: string) => void | Promise<void>;
  removeCookie: (url: string, name: string) => Promise<void>;
  startCallback?: (expectedState: string) => Promise<NativeAuthCallback>;
  sessionStore: {
    clear: typeof clearSessionToken;
    get: typeof getSessionToken;
    save: typeof saveSessionToken;
  };
}

let runtime: NativeAuthOptions | null = null;

export const configureNativeAuth = (options: NativeAuthOptions): void => {
  runtime = options;
};

const getRuntime = (): NativeAuthOptions => {
  if (!runtime) {
    throw new Error("Native auth is not configured");
  }
  return runtime;
};

// Evict the session cookies installed by prior builds, so that
// header auth takes precedence.
async function clearLegacySessionCookies(): Promise<void> {
  const options = getRuntime();
  const url = options.getPlatformUrl();
  await Promise.all(
    ["sessionid", "__Secure-sessionid"].map((name) =>
      options.removeCookie(url, name).catch(() => undefined),
    ),
  );
}

let activePkceCancel: ((reason?: string) => void) | null = null;

/**
 * App-held PKCE login (workos-pkce.ts). Drives the WorkOS OAuth flow in
 * the main process; the renderer is uninvolved beyond the IPC result.
 */
async function startOAuth(options: {
  loginHint?: string;
  intent?: string;
}): Promise<{ sessionToken: string }> {
  activePkceCancel?.();

  const runtimeOptions = getRuntime();
  const platformUrl = runtimeOptions.getPlatformUrl();
  const clientId = await fetchWorkosClientId(platformUrl);
  const state = generateState();
  const { verifier, challenge } = generatePkcePair();
  const listener = await (
    runtimeOptions.startCallback ?? startLoopbackListener
  )(state);

  const timer = setTimeout(
    () => listener.close("Sign-in timed out. Please try again."),
    AUTH_FLOW_TIMEOUT_MS,
  );
  const cancelListener = listener.close;
  activePkceCancel = cancelListener;

  try {
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri: listener.redirectUri,
      challenge,
      state,
      loginHint: options.loginHint,
      intent: options.intent,
    });
    void runtimeOptions.openExternal(authorizeUrl);

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

    runtimeOptions.sessionStore.save(sessionToken);
    void runtimeOptions.activateWindow();
    return { sessionToken };
  } finally {
    clearTimeout(timer);
    cancelListener();
    if (activePkceCancel === cancelListener) {
      activePkceCancel = null;
    }
  }
}

const startOAuthSchema = z.tuple([
  z.object({
    loginHint: z.string().optional(),
    intent: z.string().optional(),
  }),
]);

let installed = false;

export const installNativeAuth = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  const options = getRuntime();
  void clearLegacySessionCookies();

  options.ipc.handle(
    "vellum:auth:startOAuth",
    startOAuthSchema,
    async ([authOptions]): Promise<{ sessionToken: string }> =>
      startOAuth(authOptions),
  );

  options.ipc.handle("vellum:auth:cancelOAuth", z.tuple([]), () => {
    activePkceCancel?.();
  });

  options.ipc.handle("vellum:auth:signOut", z.tuple([]), () => {
    options.sessionStore.clear();
  });

  options.ipc.handleSync("vellum:auth:getSessionToken", () =>
    options.sessionStore.get(),
  );
};

export const __resetForTesting = (): void => {
  installed = false;
  activePkceCancel?.();
};

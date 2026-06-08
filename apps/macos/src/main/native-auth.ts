import crypto from "node:crypto";
import { app, net, session, shell } from "electron";
import { z } from "zod";

import { resolveLocalConfigFromEnv } from "@vellumai/local-mode";

import { handle } from "./ipc";

const AUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

interface PendingFlow {
  resolve: (sessionToken: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  codeVerifier: string;
}

const pendingFlows = new Map<string, PendingFlow>();

export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function computeCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function buildStartUrl(
  platformUrl: string,
  state: string,
  options: {
    providerHint?: string;
    loginHint?: string;
    clientVersion?: string;
    codeChallenge?: string;
  },
): string {
  const url = new URL("/accounts/native/start", platformUrl);
  url.searchParams.set("state", state);
  if (options.providerHint) url.searchParams.set("provider_hint", options.providerHint);
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  if (options.clientVersion) url.searchParams.set("client_version", options.clientVersion);
  if (options.codeChallenge) url.searchParams.set("code_challenge", options.codeChallenge);
  return url.toString();
}

async function exchangeCode(
  platformUrl: string,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const url = `${new URL(platformUrl).origin}/accounts/native/exchange`;
  const response = await net.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Code exchange failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { session_token: string };
  return data.session_token;
}

async function installSessionCookie(
  platformUrl: string,
  sessionToken: string,
): Promise<void> {
  const target = new URL(platformUrl);
  const domain = target.hostname.includes("vellum.ai")
    ? ".vellum.ai"
    : target.hostname;
  const isSecure = target.protocol === "https:";
  const expirationDate = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;

  await session.defaultSession.cookies.set({
    url: platformUrl,
    name: "sessionid",
    value: sessionToken,
    domain,
    path: "/",
    secure: isSecure,
    httpOnly: true,
    sameSite: "lax",
    expirationDate,
  });

  if (isSecure) {
    await session.defaultSession.cookies.set({
      url: platformUrl,
      name: "__Secure-sessionid",
      value: sessionToken,
      domain,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate,
    });
  }
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

// The cookie must be installed against the platform URL the renderer's
// proxy actually talks to (which may be localhost in dev).
function resolveProxyPlatformUrl(): string {
  return resolveLocalConfigFromEnv(process.env).platformUrl;
}

async function startOAuth(options: {
  providerHint?: string;
  loginHint?: string;
  intent?: string;
}): Promise<{ sessionToken: string }> {
  cancelPendingFlows();

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const authPlatformUrl = resolveAuthPlatformUrl();
  const clientVersion = app.getVersion();

  const url = buildStartUrl(authPlatformUrl, state, {
    providerHint: options.providerHint,
    loginHint: options.loginHint,
    clientVersion,
    codeChallenge,
  });

  const sessionToken = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFlows.delete(state);
      reject(new Error("Sign-in timed out. Please try again."));
    }, AUTH_FLOW_TIMEOUT_MS);

    pendingFlows.set(state, { resolve, reject, timer, codeVerifier });
    void shell.openExternal(url);
  });

  await installSessionCookie(resolveProxyPlatformUrl(), sessionToken);
  return { sessionToken };
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
    const sessionToken = await exchangeCode(resolveAuthPlatformUrl(), code, flow.codeVerifier);
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

  handle(
    "vellum:auth:startOAuth",
    startOAuthSchema,
    async ([options]): Promise<{ sessionToken: string }> => {
      return startOAuth(options);
    },
  );

  handle("vellum:auth:cancelOAuth", z.tuple([]), () => {
    cancelPendingFlows();
  });
};

export const __resetForTesting = (): void => {
  installed = false;
  cancelPendingFlows();
};

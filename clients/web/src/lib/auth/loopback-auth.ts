/**
 * Browser login for the local-mode web UI (`vellum client --interface web`).
 * The local web server holds the WorkOS PKCE exchange: `/__local/login/start`
 * returns the authorize URL to navigate to, and the server's `/auth/callback`
 * installs the session token for its proxy and 302s back into the SPA.
 */

const FALLBACK_WEB_URL = "https://www.vellum.ai";

interface VellumConfig {
  webUrl?: string;
}

function getLocalConfig(): { webUrl: string } {
  const injected = (window as unknown as { __VELLUM_CONFIG__?: VellumConfig })
    .__VELLUM_CONFIG__;
  if (injected?.webUrl) {
    return { webUrl: injected.webUrl };
  }
  return { webUrl: FALLBACK_WEB_URL };
}

export function isPlatformLocal(): boolean {
  return getLocalConfig().webUrl === window.location.origin;
}

export function useIsPlatformLocal(): boolean {
  return isPlatformLocal();
}

export async function startLoopbackAuth(
  returnTo?: string,
  options?: { intent?: string },
): Promise<void> {
  const params = new URLSearchParams();
  if (returnTo) {
    params.set("returnTo", returnTo);
  }
  if (options?.intent) {
    params.set("intent", options.intent);
  }

  const res = await fetch(`/assistant/__local/login/start?${params}`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Login start failed (${res.status})`);
  }
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  window.location.href = authorizeUrl;
}

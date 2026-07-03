/**
 * Loopback authentication for local-mode web UI.
 *
 * Mirrors the CLI's `vellum login` browser flow: navigates to the
 * platform's login page, which authenticates via WorkOS and redirects
 * back to `http://localhost:{port}/callback?state=...&session_token=...`.
 * The local web server forwards `/callback` to the SPA's `PlatformLoopbackPage`,
 * which validates the state and registers the token with the local server so
 * its platform proxy can authenticate — no browser session cookie is used.
 */

const FALLBACK_WEB_URL = "https://www.vellum.ai";
const LOOPBACK_STATE_KEY = "vellum:loopback:state";
const LOOPBACK_RETURN_TO_KEY = "vellum:loopback:returnTo";

interface VellumConfig {
  webUrl?: string;
  platformUrl?: string;
}

function getLocalConfig(): { webUrl: string } {
  const injected = (window as unknown as { __VELLUM_CONFIG__?: VellumConfig })
    .__VELLUM_CONFIG__;
  if (injected?.webUrl) return { webUrl: injected.webUrl };
  return { webUrl: FALLBACK_WEB_URL };
}

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
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
  const { webUrl } = getLocalConfig();
  const state = generateState();
  const port = window.location.port || "3000";

  sessionStorage.setItem(LOOPBACK_STATE_KEY, state);
  if (returnTo) {
    sessionStorage.setItem(LOOPBACK_RETURN_TO_KEY, returnTo);
  }

  const callbackReturnTo = `/accounts/cli/callback?port=${port}&state=${state}`;
  const page = options?.intent === "signup" ? "signup" : "login";
  const loginUrl = `${webUrl}/account/${page}?returnTo=${encodeURIComponent(callbackReturnTo)}`;

  window.location.href = loginUrl;
}

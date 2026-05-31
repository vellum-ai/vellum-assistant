/**
 * Loopback authentication for local-mode web UI.
 *
 * Mirrors the CLI's `vellum login` browser flow: navigates to the
 * platform's login page, which authenticates via WorkOS and redirects
 * back to `http://127.0.0.1:{port}/callback?state=...&session_token=...`.
 * The local web server forwards `/callback` to the SPA's
 * `PlatformLoopbackPage` which validates the state and installs the
 * session cookie.
 */

const FALLBACK_WEB_URL = "https://www.vellum.ai";
const LOOPBACK_STATE_KEY = "vellum:loopback:state";
const LOOPBACK_RETURN_TO_KEY = "vellum:loopback:returnTo";

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getWebUrl(): Promise<string> {
  try {
    const res = await fetch("/__config");
    if (res.ok) {
      const config = (await res.json()) as { webUrl?: string };
      if (config.webUrl) return config.webUrl;
    }
  } catch {
    // Fall through to default
  }
  return FALLBACK_WEB_URL;
}

export async function startLoopbackAuth(returnTo?: string): Promise<void> {
  const [webUrl, state] = await Promise.all([
    getWebUrl(),
    Promise.resolve(generateState()),
  ]);
  const port = window.location.port || "3000";

  sessionStorage.setItem(LOOPBACK_STATE_KEY, state);
  if (returnTo) {
    sessionStorage.setItem(LOOPBACK_RETURN_TO_KEY, returnTo);
  }

  const callbackReturnTo = `/accounts/cli/callback?port=${port}&state=${state}`;
  const loginUrl = `${webUrl}/account/login?returnTo=${encodeURIComponent(callbackReturnTo)}`;

  window.location.href = loginUrl;
}

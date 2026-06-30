import { Capacitor, registerPlugin } from "@capacitor/core";
import { useSyncExternalStore } from "react";

import {
  type ProviderRedirectOptions,
  startProviderRedirect,
} from "@/domains/account/social-auth";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { getSession } from "@/lib/auth/allauth-client";
import { isPlatformLocal, startLoopbackAuth } from "@/lib/auth/loopback-auth";
import { isLocalMode } from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { setMenuPlatformSession } from "@/runtime/menu";
import { primeElectronSessionToken } from "@/runtime/session-token";
import { isBiometricEnabled, storeBiometricToken } from "@/runtime/native-biometric";
import { routes } from "@/utils/routes";

/**
 * JS ↔ native bridge for the `NativeAuth` Capacitor plugin registered by
 * `clients/ios/App/App/MyViewController.swift` +
 * `clients/ios/App/App/NativeAuthPlugin.swift`.
 *
 * The plugin opens an `ASWebAuthenticationSession` pointed at
 * `{baseURL}/accounts/native/start?state={nonce}`, which initiates the
 * OIDC flow server-side and redirects directly to the WorkOS authorize URL.
 * After authentication, the callback chain delivers a short-lived, single-use
 * authorization code via the custom URL scheme.  The Swift plugin exchanges
 * that code for a Django session token via POST to
 * `/accounts/native/exchange` — the raw session key never transits the
 * custom scheme (ATL-454).
 *
 * Why native auth exists at all: Google and other IdPs refuse OAuth in
 * embedded `WKWebView` (`disallowed_useragent`). The system browser sheet
 * opened by `ASWebAuthenticationSession` satisfies their rules and shares
 * Safari's cookie jar so SSO still works.
 */

interface NativeAuthPlugin {
  startAuth(options: {
    baseURL: string;
    loginHint?: string;
    providerHint?: string;
    intent?: string;
  }): Promise<{ sessionToken: string }>;
}

const NativeAuth = registerPlugin<NativeAuthPlugin>("NativeAuth");

/** Fallback destination after a successful native login. */
const DEFAULT_POST_AUTH_DESTINATION = routes.assistant;

// True while the Electron OAuth flow awaits its deep-link callback. The
// redirect refocuses the window before the code exchange finishes, so the
// auth store skips app-resume session probes while this is set.
let oauthFlowInFlight = false;

export function isOAuthFlowInFlight(): boolean {
  return oauthFlowInFlight;
}

/**
 * Origin to present to the native OAuth flow. The Capacitor shell's
 * `server.url` lives at `https://dev-assistant.vellum.ai/assistant`; we
 * derive the bare origin for the login URL the plugin constructs.
 */
export function deriveAuthBaseURL(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

/**
 * True when we're running inside the Capacitor iOS shell (i.e. the
 * `NativeAuth` plugin is available). Safe to call server-side — falls
 * through to `false` before hydration.
 */
export function isNativePlatform(): boolean {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

/**
 * Hydration-safe hook that returns `false` on the server and during the
 * initial client render, then `true` after mount when running inside the
 * Capacitor shell. Uses `useSyncExternalStore` so React can synchronously
 * reconcile the server/client difference without a cascading effect.
 */
const noop = () => () => {};
export function useIsNativePlatform(): boolean {
  return useSyncExternalStore(noop, isNativePlatform, () => false);
}

/**
 * Run the native login flow end to end. On success the Django session
 * cookie is installed into the WKWebView's cookie jar and the page is
 * navigated to `returnTo` (sanitized) or `/assistant`, so `AuthProvider`
 * re-fetches `/_allauth/browser/v1/auth/session` and renders the
 * authenticated app at the right destination.
 *
 * Throws on user cancellation (`USER_CANCELLED`) and any other error; the
 * caller decides whether to surface or swallow.
 */
export async function startNativeLogin(options?: {
  baseURL?: string;
  returnTo?: string | null;
  loginHint?: string;
  intent?: string;
}): Promise<void> {
  const baseURL = options?.baseURL ?? deriveAuthBaseURL();
  const { sessionToken } = await NativeAuth.startAuth({
    baseURL,
    ...(options?.loginHint ? { loginHint: options.loginHint } : {}),
    ...(options?.intent ? { intent: options.intent } : {}),
  });

  // `document.cookie` can't set HttpOnly, but Django validates the
  // session by DB lookup — the HttpOnly flag is client-side only.
  //
  // We set BOTH `sessionid` (dev) and `__Secure-sessionid` (prod) so
  // the same code works across environments without runtime host
  // sniffing. Whichever name the server is configured to read, it
  // finds. The `__Secure-` prefix has browser-enforced rules: HTTPS
  // origin + `Secure` attribute, both of which apply here.
  //
  // Intentionally NOT using `WKHTTPCookieStore.setCookie()` on the
  // Swift side — that was the spike's dead end. The JS-side cookie is
  // enough.
  installSessionCookies(sessionToken);

  // iOS WKWebView async-flushes `document.cookie` writes to its
  // `WKHTTPCookieStore`. Without a synchronization step, the subsequent
  // hard navigation can race the flush and the request to `/assistant`
  // goes out without the session cookie — Django sees an anonymous user,
  // `AuthProvider` redirects back to `/account/login`, and the user is
  // dumped at the login screen even though auth itself succeeded.
  //
  // Probe `/_allauth/browser/v1/auth/session` until the server agrees
  // we're authenticated. This both (a) forces WKWebView to flush the
  // cookie store so subsequent requests carry the cookie and (b) confirms
  // Django actually recognized it before we navigate.
  //
  // The biometric branch below incidentally awaited enough async work
  // to mask the race for biometrics-enabled users, which is why this
  // bug only reproduces consistently when biometrics is off.
  if (isNativePlatform()) {
    await waitForNativeSessionCookie();
  }

  // Persist the token in the Keychain for biometric session recovery.
  // Respects the user's opt-out preference; storeBiometricToken is also
  // a no-op if biometrics are unavailable on the device.
  if (isBiometricEnabled()) {
    await storeBiometricToken(sessionToken);
  }

  // Honor returnTo (sanitized to prevent open-redirect) so deep links
  // and post-login destinations work the same way as the web flow.
  // `sanitizeReturnTo` handles nullish / empty / malformed values by
  // returning the fallback.
  const destination = sanitizeReturnTo(
    options?.returnTo ?? null,
    DEFAULT_POST_AUTH_DESTINATION,
  );
  window.location.href = destination;
}

/**
 * Block until the just-written session cookie is reachable to Django.
 *
 * Polls `getSession()` with backoff. Each call is a real same-origin
 * fetch with `credentials: "include"`, so iOS WKWebView has to send the
 * cookie from its store — if `document.cookie` hasn't flushed yet, the
 * server returns anonymous and we retry until it does.
 *
 * If every attempt fails we still fall through and let the navigation
 * proceed; the post-nav `AuthProvider` may succeed once the store
 * finally settles, and a stuck loop here would block the user worse
 * than a possible re-login.
 */
export async function waitForNativeSessionCookie(): Promise<void> {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        return;
      }
    } catch {
      // Transient network errors fall through to the backoff.
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
}

/**
 * Install Django session cookies for both dev and prod environments.
 * Sets both `sessionid` (dev) and `__Secure-sessionid` (prod) so the
 * same code works across environments without runtime host sniffing.
 */
export function installSessionCookies(sessionToken: string): void {
  // `max-age` makes the cookie persistent. If unspecified, the cookie
  // expires at the end of the session, and users will be required to
  // login again.
  const cookieAttrs = "path=/; domain=.vellum.ai; secure; samesite=lax; max-age=1209600";
  document.cookie = `sessionid=${sessionToken}; ${cookieAttrs}`;
  document.cookie = `__Secure-sessionid=${sessionToken}; ${cookieAttrs}`;
}

/**
 * Read the current Django session token from cookies.
 * Checks `__Secure-sessionid` (prod) then `sessionid` (dev).
 */
export function getSessionTokenFromCookies(): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split("; ");
  for (const name of ["__Secure-sessionid", "sessionid"]) {
    const entry = cookies.find((c) => c.startsWith(`${name}=`));
    if (entry) {
      const value = entry.slice(name.length + 1);
      if (value) return value;
    }
  }
  return null;
}

/**
 * Unified auth-flow entry point that transparently chooses between the
 * native iOS plugin path and the web form-POST path.
 *
 * Call sites pass the same args they'd pass to `startProviderRedirect()`,
 * plus an optional `returnTo`; on Capacitor we route through
 * `startNativeLogin()` (which handles the cookie + navigation
 * internally), otherwise we fall through to the existing web flow.
 *
 * On the web path, errors propagate to the caller so the UI can display
 * feedback (e.g. inline error messages on the login form). On the native
 * path, `USER_CANCELLED` (user tapped cancel on the auth sheet) is
 * swallowed since it's a routine dismissal, and all other errors are
 * re-thrown for the caller to handle.
 */
export async function startAuthFlow(
  providerId: string,
  callbackUrl: string,
  options: ProviderRedirectOptions & { returnTo?: string | null } = {},
): Promise<void> {
  if (isNativePlatform()) {
    try {
      await startNativeLogin({
        returnTo:
          options.intent === "signup"
            ? routes.onboarding.privacy
            : options.returnTo ?? null,
        loginHint: options.loginHint,
        intent: options.intent,
      });
    } catch (err) {
      // Capacitor translates `call.reject(msg, code)` from Swift into a
      // JS Error whose `message` is the first arg and whose `code` is
      // the second arg (as an own property, not in `message`). Match the
      // code exactly rather than substring-matching the message.
      const errorCode = (err as { code?: unknown } | null | undefined)?.code;
      if (errorCode === "USER_CANCELLED") return;
      throw err;
    }
    return;
  }

  // Desktop (Electron): open the system browser for OAuth so the user can
  // leverage existing Google/Apple sessions. The main process handles the
  // full flow (nonce, browser, deep-link callback, code exchange, cookie
  // install) and returns the session token. Falls through to the web
  // form-POST path when the bridge method is absent (older preload).
  if (isElectron() && window.vellum?.auth?.startOAuth) {
    oauthFlowInFlight = true;
    try {
      const result = await window.vellum.auth.startOAuth({
        loginHint: options.loginHint,
        intent: options.intent,
      });
      if (result?.sessionToken) {
        primeElectronSessionToken(result.sessionToken);
        await setMenuPlatformSession(true);
        const destination = sanitizeReturnTo(
          options.intent === "signup"
            ? routes.onboarding.privacy
            : options.returnTo ?? null,
          DEFAULT_POST_AUTH_DESTINATION,
        );
        window.location.href = destination;
      }
    } finally {
      oauthFlowInFlight = false;
    }
    return;
  }

  // Standalone local mode (no local Django serving the SPA): redirect
  // through the platform's login page and back to a loopback callback.
  if (isLocalMode() && !isPlatformLocal()) {
    await startLoopbackAuth(options.returnTo ?? undefined, {
      intent: options.intent,
    });
    return;
  }

  // Web path: `options` carries an extra `returnTo` field that the web
  // `startProviderRedirect` doesn't care about — TS's structural typing
  // accepts the superset, and the web flow plumbs `returnTo` through
  // `callbackUrl` instead. Errors propagate to the caller.
  await startProviderRedirect(providerId, callbackUrl, options);
}

import { Capacitor, registerPlugin } from "@capacitor/core";
import { useSyncExternalStore } from "react";

import {
  type ProviderRedirectOptions,
  startProviderRedirect,
} from "@/lib/account/social-auth.js";
import { sanitizeReturnTo } from "@/lib/account/return-to.js";
import { isBiometricEnabled, storeBiometricToken } from "@/runtime/native-biometric.js";
import { routes } from "@/utils/routes.js";

/**
 * JS ↔ native bridge for the `NativeAuth` Capacitor plugin registered by
 * `web/ios/App/App/MyViewController.swift` +
 * `web/ios/App/App/NativeAuthPlugin.swift`.
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
  }): Promise<{ sessionToken: string }>;
}

const NativeAuth = registerPlugin<NativeAuthPlugin>("NativeAuth");

/** Fallback destination after a successful native login. */
const DEFAULT_POST_AUTH_DESTINATION = routes.assistant;

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
  providerHint?: string;
}): Promise<void> {
  const baseURL = options?.baseURL ?? deriveAuthBaseURL();
  const { sessionToken } = await NativeAuth.startAuth({
    baseURL,
    ...(options?.loginHint ? { loginHint: options.loginHint } : {}),
    ...(options?.providerHint ? { providerHint: options.providerHint } : {}),
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
 * Install Django session cookies for both dev and prod environments.
 * Sets both `sessionid` (dev) and `__Secure-sessionid` (prod) so the
 * same code works across environments without runtime host sniffing.
 */
export function installSessionCookies(sessionToken: string): void {
  const cookieAttrs = "path=/; domain=.vellum.ai; secure; samesite=lax";
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
 * Adding this wrapper means every auth entry point in the app (login,
 * signup, marketing nav, account) gets native routing for free without
 * each having to know about Capacitor.
 */
export async function startAuthFlow(
  providerId: string,
  callbackUrl: string,
  options: ProviderRedirectOptions & { returnTo?: string | null } = {},
): Promise<void> {
  try {
    if (isNativePlatform()) {
      await startNativeLogin({
        returnTo: options.returnTo ?? null,
        loginHint: options.loginHint,
        providerHint: options.providerHint,
      });
      return;
    }
    // `options` carries an extra `returnTo` field that the web
    // `startProviderRedirect` doesn't care about — TS's structural typing
    // accepts the superset, and the web flow plumbs `returnTo` through
    // `callbackUrl` instead. No need to destructure it out.
    await startProviderRedirect(providerId, callbackUrl, options);
  } catch (err) {
    // USER_CANCELLED is routine (user tapped cancel on the auth sheet);
    // swallow quietly. Anything else is a real failure — surface it to
    // the console so it shows up in the Capacitor bridge log and Xcode's
    // device console, rather than becoming a silent unhandled-rejection.
    //
    // Capacitor translates `call.reject(msg, code)` from Swift into a JS
    // Error whose `message` is the first arg and whose `code` is the
    // second arg (as an own property, not in `message`). Match the code
    // exactly rather than substring-matching the message — a substring
    // check ("cancel") would also swallow unrelated iOS errors that
    // happen to include the word in their localized description.
    //
    // TODO(LUM-1127 follow-up): plumb a visible toast/inline error so
    // users get feedback on non-cancellation failures.
    const errorCode = (err as { code?: unknown } | null | undefined)?.code;
    if (errorCode !== "USER_CANCELLED") {
      console.error("[native-auth] auth flow failed:", err);
    }
  }
}

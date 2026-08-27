import { Capacitor, registerPlugin } from "@capacitor/core";
import { useSyncExternalStore } from "react";

import {
  type ProviderRedirectOptions,
  readAttributionParams,
  startProviderRedirect,
} from "@/domains/account/social-auth";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { getSession } from "@/lib/auth/allauth-client";
import { hasOnboardedAssistant } from "@/domains/onboarding/onboarded-assistant";
import { resolveSignupCheckoutDestination } from "@/lib/billing/post-auth-checkout";
import { isPlatformLocal, startLoopbackAuth } from "@/lib/auth/loopback-auth";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { isLocalClient } from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { setMenuPlatformSession } from "@/runtime/menu";
import { primeElectronSessionToken } from "@/runtime/session-token";
import {
  captureInstallReferrer,
  markInstallReferrerSpent,
} from "@/runtime/install-referrer";
import {
  isBiometricEnabled,
  setBiometricEnabled,
  storeBiometricToken,
} from "@/runtime/native-biometric";
import { routes } from "@/utils/routes";

/**
 * JS ↔ native bridge for the `NativeAuth` Capacitor plugin registered by the
 * iOS and Android native shells.
 *
 * The plugins open the platform browser auth surface against WorkOS AuthKit
 * with PKCE. After authentication, WorkOS delivers a short-lived,
 * single-use authorization code via the custom URL scheme. The native plugin
 * exchanges that code for a WorkOS access token, then swaps it for a platform
 * session token. The raw session key never transits the custom scheme.
 *
 * Why native auth exists at all: Google and other IdPs refuse OAuth in
 * embedded WebViews (`disallowed_useragent`). The native plugins open the
 * platform browser auth surface instead and return a platform session token.
 */

interface NativeAuthPlugin {
  startAuth(options: {
    baseURL: string;
    loginHint?: string;
    intent?: string;
    /**
     * Allowlisted campaign params. The shell appends them as query params on
     * its token POST: allauth headless posts JSON, so the platform reads
     * attribution off `request.GET`. Omitted when empty, so a shell that
     * predates this field sees an unchanged call.
     */
    attribution?: Record<string, string>;
    postAuthDestination: string;
  }): Promise<{ sessionToken: string }>;
  consumeRestoredAuth(): Promise<{
    sessionToken?: string;
    postAuthDestination?: string;
    error?: string;
    errorCode?: string;
  }>;
}

const NativeAuth = registerPlugin<NativeAuthPlugin>("NativeAuth");

/** Fallback destination after a successful native login. */
const DEFAULT_POST_AUTH_DESTINATION = routes.assistant;

const desktopUpdateRequiredAuthError = (): Error => {
  const error = new Error(
    "The desktop auth bridge is unavailable. Update the app to sign in.",
  ) as Error & { code: string; data: { authError: string } };
  error.code = "AUTH_ERROR";
  error.data = { authError: "desktop_update_required" };
  return error;
};

// True while the Electron OAuth flow awaits its deep-link callback. The
// redirect refocuses the window before the code exchange finishes, so the
// auth store skips app-resume session probes while this is set.
let oauthFlowInFlight = false;

export function isOAuthFlowInFlight(): boolean {
  return oauthFlowInFlight;
}

/**
 * Origin to present to the native OAuth flow. The Capacitor shell's
 * `server.url` includes `/assistant`; the plugins need the bare origin for
 * the login URL they construct.
 */
export function deriveAuthBaseURL(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

/**
 * True when we're running inside a Capacitor native shell. Safe to call
 * server-side, so it falls through to `false` before hydration.
 */
export function isNativePlatform(): boolean {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

/**
 * Hook form of `isNativePlatform()`, safe to call from a render body.
 *
 * The value is correct on the very first render and constant thereafter:
 * Capacitor injects `native-bridge.js` as a `WKUserScript` at
 * `.atDocumentStart`, so `window.Capacitor` exists before this bundle
 * executes. `subscribe` is a noop because nothing can change the value, and
 * the `getServerSnapshot` argument is unreachable because `clients/web`
 * renders client-only through `createRoot` (no SSR, no hydration).
 *
 * Prefer it over the bare function in JSX (docs/CAPACITOR.md): it keeps the
 * shape consistent with the platform hooks in `runtime/platform-detection.ts`
 * and stays correct if a prerender step is ever added. There is no first-paint
 * flicker to avoid.
 */
const noop = () => () => {};
export function useIsNativePlatform(): boolean {
  return useSyncExternalStore(noop, isNativePlatform, () => false);
}

/**
 * Run the native login flow end to end. On success the Django session
 * cookie is installed into the native WebView cookie store and the page is
 * navigated to `returnTo` (sanitized) or `/assistant`, so `AuthProvider`
 * re-fetches `/_allauth/browser/v1/auth/session` and renders the
 * authenticated app at the right destination.
 *
 * Throws on user cancellation (`USER_CANCELLED`) and any other error; the
 * caller decides whether to surface or swallow.
 *
 * `attribution` is an explicit override; absent it, this resolves the flow's
 * attribution itself, so every native entry carries one.
 */
export async function startNativeLogin(options?: {
  baseURL?: string;
  returnTo?: string | null;
  loginHint?: string;
  intent?: string;
  attribution?: Record<string, string>;
}): Promise<void> {
  // Every native auth entry routes through the shared stale-stash cleanup. The
  // direct login form (`login-page.tsx`) calls this without going through
  // `resolveNativePostAuthDestination`, so without this a stash abandoned by a
  // prior native checkout-signup could leak into a later login and wrongly
  // resume checkout from privacy.
  clearStaleNativeCheckoutStash(options?.intent, options?.returnTo);

  // Attribution resolves here for the same reason: the direct login form is
  // the auth entry a fresh Play install reaches, and the install referrer is
  // the only attribution such an install carries.
  const attribution = await resolveNativeAttribution(options?.attribution);

  const baseURL = options?.baseURL ?? deriveAuthBaseURL();
  const destination = sanitizeReturnTo(
    options?.returnTo ?? null,
    DEFAULT_POST_AUTH_DESTINATION,
  );
  const { sessionToken } = await NativeAuth.startAuth({
    baseURL,
    ...(options?.loginHint ? { loginHint: options.loginHint } : {}),
    ...(options?.intent ? { intent: options.intent } : {}),
    ...(attribution ? { attribution } : {}),
    postAuthDestination: destination,
  });

  await completeNativeLogin(sessionToken, destination);
}

/** Resume an Android browser login whose WebView process was recreated. */
export async function restorePendingNativeLogin(): Promise<void> {
  if (!isNativePlatform() || Capacitor.getPlatform() !== "android") {
    return;
  }
  const result = await NativeAuth.consumeRestoredAuth();
  if (result.error) {
    const error = new Error(result.error) as Error & { code?: string };
    error.code = result.errorCode;
    throw error;
  }
  if (!result.sessionToken) {
    return;
  }
  const destination = sanitizeReturnTo(
    result.postAuthDestination ?? null,
    DEFAULT_POST_AUTH_DESTINATION,
  );
  await completeNativeLogin(result.sessionToken, destination);
}

async function completeNativeLogin(
  sessionToken: string,
  destination: string,
): Promise<void> {
  // `document.cookie` can't set HttpOnly, but Django validates the
  // session by DB lookup; the HttpOnly flag is client-side only.
  //
  // We set BOTH `sessionid` (dev) and `__Secure-sessionid` (prod) so
  // the same code works across environments without runtime host
  // sniffing. Whichever name the server is configured to read, it
  // finds. The `__Secure-` prefix has browser-enforced rules: HTTPS
  // origin + `Secure` attribute, both of which apply here.
  //
  // The JS-side cookie is the source of truth for the native WebView session.
  installSessionCookies(sessionToken);

  // Native WebViews can flush `document.cookie` writes asynchronously.
  // Without a synchronization step, the subsequent
  // hard navigation can race the flush and the request to `/assistant`
  // goes out without the session cookie — Django sees an anonymous user,
  // `AuthProvider` redirects back to `/account/login`, and the user is
  // dumped at the login screen even though auth itself succeeded.
  //
  // Probe `/_allauth/browser/v1/auth/session` until the server agrees
  // we're authenticated. This both (a) forces the WebView to flush the
  // cookie store so subsequent requests carry the cookie and (b) confirms
  // Django actually recognized it before we navigate.
  //
  // The biometric branch below incidentally awaited enough async work
  // to mask the race for biometrics-enabled users, which is why this
  // bug only reproduces consistently when biometrics is off.
  if (isNativePlatform()) {
    await waitForNativeSessionCookie();
  }

  markInstallReferrerSpent();

  // Persist the token in native secure storage for biometric session recovery.
  // Respects the user's opt-out preference; storeBiometricToken is also
  // a no-op if biometrics are unavailable on the device.
  if (isBiometricEnabled()) {
    const stored = await storeBiometricToken(sessionToken);
    if (!stored && Capacitor.getPlatform() === "android") {
      setBiometricEnabled(false);
    }
  }

  window.location.href = destination;
}

/**
 * Block until the just-written session cookie is reachable to Django.
 *
 * Polls `getSession()` with backoff. Each call is a real same-origin
 * fetch with `credentials: "include"`, so the native WebView has to send the
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
 * Install Django session cookies for both dev and prod environments. Sets both
 * `sessionid` (dev) and `__Secure-sessionid` (prod) so the same code works
 * across environments without runtime host sniffing.
 */
export function installSessionCookies(sessionToken: string): void {
  // `max-age` makes the cookie persistent. If unspecified, the cookie
  // expires at the end of the session, and users will be required to
  // login again.
  const cookieAttrs =
    "path=/; domain=.vellum.ai; secure; samesite=lax; max-age=1209600";
  document.cookie = `sessionid=${sessionToken}; ${cookieAttrs}`;
  document.cookie = `__Secure-sessionid=${sessionToken}; ${cookieAttrs}`;
}

/**
 * Read the current Django session token from cookies.
 * Checks `__Secure-sessionid` (prod) then `sessionid` (dev).
 */
export function getSessionTokenFromCookies(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const cookies = document.cookie.split("; ");
  for (const name of ["__Secure-sessionid", "sessionid"]) {
    const entry = cookies.find((c) => c.startsWith(`${name}=`));
    if (entry) {
      const value = entry.slice(name.length + 1);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Post-auth destination for the native (Capacitor/Electron) flows. Delegates
 * the signup checkout-stash + destination decision to the shared
 * `resolveSignupCheckoutDestination`. A first-run signup routes through
 * consent (privacy) first. An already-onboarded assistant skips hosting,
 * privacy, and research. A login keeps its `returnTo` unless that target is
 * the first-run funnel and the assistant is already onboarded.
 */
export function resolveNativePostAuthDestination(
  intent: string | undefined,
  returnTo: string | null | undefined,
): string | null {
  const isSignup = intent === "signup";
  const alreadyOnboarded = hasOnboardedAssistant(
    useResolvedAssistantsStore.getState().assistants,
  );
  if (alreadyOnboarded) {
    const skipTarget = isFirstRunOnboardingReturnTo(returnTo)
      ? routes.assistant
      : (returnTo ?? (isSignup ? routes.assistant : null));
    resolveSignupCheckoutDestination({
      intent: "login",
      returnTo: skipTarget ?? "",
    });
    return skipTarget;
  }
  const destination = resolveSignupCheckoutDestination({
    intent: isSignup ? "signup" : "login",
    returnTo: returnTo ?? "",
  });
  return isSignup ? destination : (returnTo ?? null);
}

function isFirstRunOnboardingReturnTo(
  returnTo: string | null | undefined,
): boolean {
  if (!returnTo) {
    return false;
  }
  const pathname = returnTo.split(/[?#]/)[0] ?? returnTo;
  return (
    pathname === routes.onboarding.hosting ||
    pathname === routes.onboarding.privacy ||
    pathname === routes.onboarding.research
  );
}

/**
 * Discard a checkout stash abandoned by a prior native checkout-signup so it
 * can't leak into a later native auth. Runs on every native auth entry (via
 * `startNativeLogin`), including the direct login form that skips
 * `resolveNativePostAuthDestination`.
 *
 * A signup owns its stash through `resolveSignupCheckoutDestination` — already
 * run before we reach here, and its `returnTo` is the transformed privacy
 * destination rather than the original checkout link — so we skip it to avoid
 * wiping the package it just stashed. Otherwise the shared resolver clears a
 * stale stash for a non-checkout destination and leaves an existing stash in
 * place when the destination IS a checkout deep link (a legitimate resume).
 */
export function clearStaleNativeCheckoutStash(
  intent: string | undefined,
  returnTo: string | null | undefined,
): void {
  if (intent === "signup") {
    return;
  }
  resolveSignupCheckoutDestination({
    intent: "login",
    returnTo: returnTo ?? "",
  });
}

/**
 * Attribution to hand the native shell, drawn from exactly one source.
 *
 * A caller's override wins outright, then URL params: they carry the user's
 * current, explicit campaign context. The Play install referrer is the
 * fallback, and it is the only attribution a Play install carries at all (such
 * an install arrives with no URL params).
 *
 * The two are never merged: `persist_attribution` on the platform stores a row
 * as one coherent unit from a single source, so it must not be handed fields
 * spliced from two. First touch across repeat signups is already held there by
 * the empty-row backfill guard.
 */
async function resolveNativeAttribution(
  override: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  const current = override ?? readAttributionParams(window.location.search);
  if (Object.keys(current).length > 0) {
    return current;
  }
  const referrer = await captureInstallReferrer();
  return Object.keys(referrer).length > 0 ? referrer : undefined;
}

/**
 * Unified auth-flow entry point that transparently chooses between the
 * native plugin path and the web form-POST path.
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
        returnTo: resolveNativePostAuthDestination(
          options.intent,
          options.returnTo,
        ),
        loginHint: options.loginHint,
        intent: options.intent,
        attribution: options.attribution,
      });
    } catch (err) {
      // Capacitor translates native `call.reject(msg, code)` into a
      // JS Error whose `message` is the first arg and whose `code` is
      // the second arg (as an own property, not in `message`). Match the
      // code exactly rather than substring-matching the message.
      const errorCode = (err as { code?: unknown } | null | undefined)?.code;
      if (errorCode === "USER_CANCELLED") {
        return;
      }
      throw err;
    }
    return;
  }

  // Electron requires the native OAuth bridge. The web and CLI callback
  // fallbacks have no receiver inside the desktop shell.
  if (isElectron()) {
    if (!window.vellum?.auth?.startOAuth) {
      throw desktopUpdateRequiredAuthError();
    }
    oauthFlowInFlight = true;
    try {
      const result = await window.vellum.auth.startOAuth({
        loginHint: options.loginHint,
        intent: options.intent,
      });
      if (result?.sessionToken) {
        primeElectronSessionToken(result.sessionToken);
        // Reconcile the account before choosing where login lands. Keep this
        // dynamic because auth-store imports this module.
        const { useAuthStore, whenPlatformSessionSettled } = await import(
          "@/stores/auth-store"
        );
        await useAuthStore.getState().refreshSession();
        await whenPlatformSessionSettled();
        await setMenuPlatformSession(true);
        const destination = sanitizeReturnTo(
          resolveNativePostAuthDestination(options.intent, options.returnTo),
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
  if (isLocalClient() && !isPlatformLocal()) {
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

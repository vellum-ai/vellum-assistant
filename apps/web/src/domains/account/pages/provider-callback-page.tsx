import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import * as Sentry from "@sentry/react";

import { AccountHeading } from "@/components/account/account-form.js";
import { AccountShell } from "@/components/account/account-shell.js";
import { getSession } from "@/lib/auth/allauth-client.js";
import { resolvePostLoginDestination } from "@/domains/account/login-flow.js";
import { classifyCallbackFlows } from "@/domains/account/social-auth.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { routes } from "@/utils/routes.js";

const NATIVE_CALLBACK_PREFIX = "/accounts/native/callback";

/** Mirrors NATIVE_AUTH_ALLOWED_SCHEMES in django/config/settings/base.py. */
const ALLOWED_SCHEMES = new Set([
  "vellum",
  "vellum-assistant",
  "vellum-assistant-dev",
  "vellum-assistant-staging",
  "vellum-assistant-local",
]);

/**
 * When the provider callback is reached via the native iOS/macOS auth flow
 * (returnTo points to the native callback endpoint), extract the custom
 * URL scheme and state so we can redirect back to the app — even on error.
 */
function parseNativeReturnTo(
  returnTo: string | null,
): { scheme: string; state: string } | null {
  if (!returnTo?.startsWith(NATIVE_CALLBACK_PREFIX)) return null;
  try {
    const params = new URL(returnTo, "https://placeholder").searchParams;
    const scheme = params.get("scheme");
    const state = params.get("state");
    if (scheme && state && ALLOWED_SCHEMES.has(scheme)) {
      return { scheme, state };
    }
  } catch {
    // Malformed returnTo — fall through
  }
  return null;
}

/**
 * Bounce back to the native app via its custom URL scheme. The macOS/iOS
 * client treats any `?error=…` query param as a failed login.
 */
function redirectToNativeApp(
  nativeParams: { scheme: string; state: string },
  error: string,
): void {
  const { scheme, state } = nativeParams;
  window.location.href = `${scheme}://auth/callback?error=${encodeURIComponent(error)}&state=${encodeURIComponent(state)}`;
}

/**
 * True if the current browser is iOS or iPadOS. iPadOS 13+ reports a
 * Macintosh user agent by default, so we disambiguate via
 * `maxTouchPoints > 1` on a Mac platform — real Macs report 0 or 1.
 * `"ontouchend" in document` is NOT a reliable touch-device signal on
 * desktop Safari (the API exists on desktop too), which is why we don't
 * use it. Same discriminator as `isIOSBrowser` in
 * `domains/nudges/ios-app-platform.ts`.
 *
 * Ref: https://developer.apple.com/forums/thread/119186
 */
function isIOSBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
  return isMacPlatform && navigator.maxTouchPoints > 1;
}


/**
 * OAuth provider callback handler. Probes the allauth session after the
 * IdP redirect and routes the user to the correct next step:
 * - Authenticated → navigate to returnTo or home
 * - Provider signup needed → redirect to provider signup page
 * - Error → display inline error with back-to-login link
 */
export function ProviderCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const refreshSession = useAuthStore.use.refreshSession();
  const error = searchParams.get("error");
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const didRun = useRef(false);

  const returnTo = searchParams.get("returnTo");
  const nativeParams = useMemo(() => parseNativeReturnTo(returnTo), [returnTo]);

  useEffect(() => {
    if (didRun.current) return;

    if (error && nativeParams) {
      didRun.current = true;
      redirectToNativeApp(nativeParams, error);
      return;
    }

    if (error) return;
    didRun.current = true;

    (async () => {
      try {
        const result = await getSession();

        const isAuthenticated = result.ok && !!result.data.user;
        const pendingFlows = result.ok ? [] : (result.flows ?? []);
        const outcome = classifyCallbackFlows(isAuthenticated, pendingFlows);

        switch (outcome.kind) {
          case "authenticated": {
            await refreshSession();
            const fallback = routes.assistant;
            const { destination, requiresFullPageNavigation } =
              resolvePostLoginDestination(returnTo, fallback);
            if (requiresFullPageNavigation) {
              window.location.href = destination;
            } else {
              navigate(destination, { replace: true });
            }
            break;
          }
          case "provider_signup": {
            if (nativeParams) {
              redirectToNativeApp(nativeParams, "provider_signup_required");
              return;
            }
            const returnToParam = searchParams.get("returnTo");
            const signupUrl = returnToParam
              ? `${routes.account.providerSignup}?returnTo=${encodeURIComponent(returnToParam)}`
              : routes.account.providerSignup;
            navigate(signupUrl, { replace: true });
            break;
          }
          case "error":
            // Skip the native-scheme bounce on iOS only: it tears the
            // `ASWebAuthenticationSession` Safari sheet down before
            // WebKit finishes committing the session cookie set by
            // allauth's social callback, turning a recoverable
            // post-WorkOS failure into a permanent one. macOS does
            // not exhibit this and still needs the bounce so its
            // auth sheet closes cleanly into the native UI.
            if (nativeParams && !isIOSBrowser()) {
              redirectToNativeApp(nativeParams, outcome.message);
              return;
            }
            setFallbackError(outcome.message);
            break;
        }
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "provider_callback" },
        });
        setFallbackError("Something went wrong. Please try signing in again.");
      }
    })();
  }, [error, nativeParams, refreshSession, returnTo, navigate, searchParams]);

  if (error === "signup_closed") {
    return (
      <AccountShell>
        <AccountHeading
          title="Signups are currently closed"
          subtitle="Please contact support to join the waitlist."
        />
        <div className="flex flex-col items-center gap-4">
          <Link
            to={routes.account.login}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-white no-underline transition-colors hover:bg-[var(--primary-hover)]"
          >
            Back to sign in
          </Link>
        </div>
      </AccountShell>
    );
  }

  if (error || fallbackError) {
    return (
      <AccountShell>
        <AccountHeading
          title="Authentication failed"
          subtitle={
            fallbackError ??
            "Something went wrong during social sign-in. Please try again or use a different method."
          }
        />
        <div className="flex flex-col items-center gap-4">
          <Link
            to={routes.account.login}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-white no-underline transition-colors hover:bg-[var(--primary-hover)]"
          >
            Back to sign in
          </Link>
        </div>
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <AccountHeading
        title="Completing sign-in..."
        subtitle="Please wait while we finish authenticating you."
      />
    </AccountShell>
  );
}

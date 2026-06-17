import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { captureError } from "@/lib/sentry/capture-error";

import { AccountHeading } from "@/components/account/account-form";
import { AccountShell } from "@/components/account/account-shell";
import { listAssistants } from "@/assistant/api";
import { getSession } from "@/lib/auth/allauth-client";
import {
  readAuthCallbackIntent,
  resolvePostAuthDestination,
} from "@/domains/account/login-flow";
import { classifyCallbackFlows } from "@/domains/account/social-auth";
import { isLocalMode, syncPlatformAssistantsToLockfile } from "@/lib/local-mode";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { VELLUM_COMMUNITY_URL } from "@/utils/external-urls";
import { routes } from "@/utils/routes";

/**
 * OAuth provider callback handler for the **web** login flow.
 *
 * After the IdP redirect, probes the allauth session and routes the user
 * to the correct next step:
 * - Authenticated → navigate to returnTo or home
 * - Provider signup needed → redirect to provider signup page
 * - Error → display inline error with back-to-login link
 *
 * Native auth flows (iOS / macOS) no longer route through this page.
 * The server-side native auth flow redirects directly from the allauth
 * callback to `/accounts/native/callback` without loading any SPA.
 */
export function ProviderCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const refreshSession = useAuthStore.use.refreshSession();
  const error = searchParams.get("error");
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const didRun = useRef(false);

  const returnTo = searchParams.get("returnTo");
  const authIntent = readAuthCallbackIntent(searchParams);

  useEffect(() => {
    if (didRun.current) return;
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

            if (isLocalMode()) {
              try {
                const assistants = await listAssistants();
                if (assistants.ok && assistants.data.length > 0) {
                  await syncPlatformAssistantsToLockfile(
                    assistants.data,
                    useOrganizationStore.getState().currentOrganizationId ?? undefined,
                  );
                  if (!returnTo) {
                    navigate(routes.assistant, { replace: true });
                    break;
                  }
                }
              } catch {
                // Fall through to normal destination
              }
            }

            const fallback = routes.assistant;
            const { destination, requiresFullPageNavigation } =
              resolvePostAuthDestination({ returnTo, fallback, authIntent });
            if (requiresFullPageNavigation) {
              window.location.href = destination;
            } else {
              navigate(destination, { replace: true });
            }
            break;
          }
          case "provider_signup": {
            const returnToParam = searchParams.get("returnTo");
            const signupUrl = returnToParam
              ? `${routes.account.providerSignup}?returnTo=${encodeURIComponent(returnToParam)}`
              : routes.account.providerSignup;
            navigate(signupUrl, { replace: true });
            break;
          }
          case "error":
            setFallbackError(outcome.message);
            break;
        }
      } catch (err) {
        captureError(err, { context: "provider_callback" });
        setFallbackError("Something went wrong. Please try signing in again.");
      }
    })();
  }, [authIntent, error, refreshSession, returnTo, navigate, searchParams]);

  if (error === "signup_closed") {
    return (
      <AccountShell>
        <AccountHeading
          title="Signups are currently closed"
          subtitle="Join the community to request access or learn when signups reopen."
        />
        <div className="flex flex-col items-center gap-4">
          <a
            href={VELLUM_COMMUNITY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-[var(--content-inset)] no-underline transition-colors hover:bg-[var(--primary-hover)]"
          >
            Join the community
          </a>
          <Link
            to={routes.account.login}
            className="text-sm font-medium text-[var(--content-emphasised)] hover:underline"
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
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-[var(--content-inset)] no-underline transition-colors hover:bg-[var(--primary-hover)]"
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

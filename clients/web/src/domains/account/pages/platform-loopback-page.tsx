import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";

import { listAssistants } from "@/assistant/api";
import { syncPlatformAssistantsToLockfile } from "@/lib/local-mode";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { routes } from "@/utils/routes";

const LOOPBACK_STATE_KEY = "vellum:loopback:state";
const LOOPBACK_RETURN_TO_KEY = "vellum:loopback:returnTo";

/**
 * Receive the session token from the platform's CLI callback redirect.
 *
 * Flow:
 *   1. Welcome screen stores a random state nonce in sessionStorage
 *      and navigates to the platform login with
 *      `returnTo=/accounts/cli/callback?port={localPort}&state={nonce}`
 *   2. After authentication, the platform redirects to
 *      `http://127.0.0.1:{port}/callback?state={nonce}&session_token={token}`
 *   3. The local web server redirects `/callback` → this SPA page
 *   4. This page validates the state, installs the session cookie,
 *      checks for existing assistants, and navigates accordingly
 */
export function PlatformLoopbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const state = searchParams.get("state");
    const sessionToken = searchParams.get("session_token");
    const expectedState = sessionStorage.getItem(LOOPBACK_STATE_KEY);
    const returnTo = sessionStorage.getItem(LOOPBACK_RETURN_TO_KEY) || routes.assistant;

    sessionStorage.removeItem(LOOPBACK_STATE_KEY);
    sessionStorage.removeItem(LOOPBACK_RETURN_TO_KEY);

    if (!state || state !== expectedState) {
      setError("Login failed: state mismatch. Please try again.");
      return;
    }

    if (!sessionToken) {
      setError("Login failed: no session token received. Please try again.");
      return;
    }

    if (!/^[a-zA-Z0-9]+$/.test(sessionToken)) {
      setError("Login failed: invalid session token.");
      return;
    }

    document.cookie = `sessionid=${sessionToken}; path=/; samesite=lax; max-age=1209600`;

    void (async () => {
      // Re-run session init now that the cookie is set — this moves
      // sessionStatus to "authenticated" so the auth middleware lets
      // navigation through.
      await useAuthStore.getState().initSession();
      await setMenuPlatformSession(true);

      try {
        const result = await listAssistants();
        if (result.ok && result.data.length > 0) {
          await syncPlatformAssistantsToLockfile(
            result.data,
            useOrganizationStore.getState().currentOrganizationId ?? undefined,
          );
          void navigate(routes.assistant, { replace: true });
          return;
        }
      } catch {
        // Failed to check — fall through to onboarding
      }
      void navigate(returnTo, { replace: true });
    })();
  }, [searchParams, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
        <div className="max-w-md text-center">
          <p className="text-body-medium-default">{error}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-[var(--border-disabled)] px-4 py-2 text-sm hover:bg-[var(--surface-lift)]"
            onClick={() => void navigate(routes.welcome)}
          >
            Back to Welcome
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
      <p className="text-body-medium-default">Completing login...</p>
    </div>
  );
}

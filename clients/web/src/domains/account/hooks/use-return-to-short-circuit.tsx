import { useEffect, type ReactElement } from "react";
import { Navigate, useSearchParams } from "react-router";

import {
  requiresFullPageNavigation,
  requiresPlatformSession,
} from "@/domains/account/login-flow";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { usePlatformGateWithPending } from "@/hooks/use-platform-gate";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import {
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/**
 * What an auth entry point should render.
 *
 * - `"wait"` — a session the decision depends on is still settling; hold the
 *   page's own loading shell.
 * - `"redirect"` — an existing session already reaches `returnTo`; render
 *   `node` instead of the auth screen.
 * - `"proceed"` — render the auth screen, handing it `returnTo`.
 */
export type ReturnToShortCircuit =
  | { kind: "wait" }
  | { kind: "redirect"; node: ReactElement }
  | { kind: "proceed"; returnTo: string | null };

/**
 * Send an already-signed-in visitor to a sanitized `returnTo` destination.
 *
 * Destinations outside this SPA (absolute URLs, Django routes, the marketing
 * import funnel) need a real page load — routing them through `<Navigate>`
 * would dead-end on the SPA's not-found route.
 */
function ReturnToRedirect({ to }: { to: string }) {
  const fullPage = requiresFullPageNavigation(to);

  useEffect(() => {
    if (fullPage) {
      hardNavigate(to);
    }
  }, [fullPage, to]);

  if (fullPage) {
    return null;
  }
  return <Navigate to={to} replace />;
}

/**
 * Decide whether `/account/login` and `/account/signup` can skip OAuth.
 *
 * A `returnTo` means something sent the visitor here on the way somewhere
 * specific, so an existing session lands there directly; a bare visit always
 * gets the auth screen, since a signed-in visitor may be switching accounts.
 *
 * `useIsAuthenticated()` also covers a local gateway identity, which has no
 * platform account, so a destination that needs one additionally waits on the
 * platform gate and falls through to the auth screen on `"disabled"`. The gate
 * is the session-only variant: a platform session is the only thing signing in
 * here can produce, so the `platformHostedOnly` dimension — which no auth
 * screen can change — must not suppress a sign-in the visitor needs.
 *
 * `"pending"` is bounded by the gate, so the auth screen can never hang on the
 * probe; `"gated"` short-circuits, since no auth screen can mint a session that
 * does not exist.
 */
export function useReturnToShortCircuit(): ReturnToShortCircuit {
  const [searchParams] = useSearchParams();
  const isAuthenticated = useIsAuthenticated();
  const isSessionInitializing = useIsSessionInitializing();
  const platformGate = usePlatformGateWithPending();

  const rawReturnTo = searchParams.get("returnTo");
  const destination = sanitizeReturnTo(rawReturnTo, routes.assistant);

  if (!rawReturnTo) {
    return { kind: "proceed", returnTo: null };
  }
  if (isSessionInitializing) {
    return { kind: "wait" };
  }
  if (!isAuthenticated) {
    return { kind: "proceed", returnTo: destination };
  }
  if (requiresPlatformSession(destination)) {
    if (platformGate === "pending") {
      return { kind: "wait" };
    }
    if (platformGate === "disabled") {
      return { kind: "proceed", returnTo: destination };
    }
  }
  return { kind: "redirect", node: <ReturnToRedirect to={destination} /> };
}

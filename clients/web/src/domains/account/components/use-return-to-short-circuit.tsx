import type { ReactElement } from "react";
import { useSearchParams } from "react-router";

import { ReturnToRedirect } from "@/domains/account/components/return-to-redirect";
import { requiresPlatformSession } from "@/domains/account/login-flow";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { usePlatformGateWithPending } from "@/hooks/use-platform-gate";
import {
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/**
 * What an auth entry point should render, given its `returnTo` and the session
 * behind it.
 *
 * - `"wait"` — a session the decision depends on is still settling. Hold the
 *   page's own loading shell; both branches below are still reachable.
 * - `"redirect"` — an existing session already reaches `returnTo`. Render
 *   `node` instead of the auth screen.
 * - `"proceed"` — render the auth screen, handing it `returnTo`.
 */
export type ReturnToShortCircuit =
  | { kind: "wait"; returnTo: string | null }
  | { kind: "redirect"; returnTo: string; node: ReactElement }
  | { kind: "proceed"; returnTo: string | null };

/**
 * Decide whether `/account/login` and `/account/signup` can skip OAuth.
 *
 * A `returnTo` means something sent the visitor here on the way somewhere
 * specific (e.g. a marketing pricing CTA), so an existing session lands there
 * directly. A bare visit always gets the auth screen — a signed-in visitor may
 * be there to switch accounts or create another one.
 *
 * "An existing session" is not the same question for every destination.
 * `useIsAuthenticated()` also covers a local gateway identity, which the
 * self-hosted and remote-gateway clients have without any platform account; a
 * platform-dependent destination reached on one of those bails on arrival and
 * discards whatever the link carried. So those destinations additionally
 * require the platform gate to clear, and fall through to the auth screen when
 * it does not — the visitor genuinely does need to sign in. A local-only
 * destination keeps the plain authenticated check, so a local-mode user is
 * never pushed into an OAuth prompt they have no use for.
 *
 * The platform-session probe's pre-settle window is a wait, not a decision, and
 * `usePlatformGateWithPending` bounds it the same way the route guard does: it
 * resolves to `"disabled"` if the probe never lands, so an auth screen can
 * never hang on it. `"gated"` — local mode with the platform API switched off —
 * short-circuits: no auth screen here can mint a session that does not exist.
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
    return { kind: "wait", returnTo: destination };
  }
  if (!isAuthenticated) {
    return { kind: "proceed", returnTo: destination };
  }
  if (requiresPlatformSession(destination)) {
    if (platformGate === "pending") {
      return { kind: "wait", returnTo: destination };
    }
    if (platformGate === "disabled") {
      return { kind: "proceed", returnTo: destination };
    }
  }
  return {
    kind: "redirect",
    returnTo: destination,
    node: <ReturnToRedirect to={destination} />,
  };
}

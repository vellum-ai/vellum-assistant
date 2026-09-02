import { useNavigate } from "react-router";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { routes } from "@/utils/routes";

/**
 * Sends the session to the assistant chooser when the local gateway rejects it
 * past what the renderer can repair on its own.
 *
 * The chooser's connect path is the one place that offers the guardian
 * re-provision, and its auto-connect reaches that dialog without a click when
 * a single assistant is installed, so the route carries no `noAutoSkip`.
 *
 * Mounted once in `RootLayout`, so a session that dies mid-conversation lands
 * on the repair from whichever route it was on. It replaces that route rather
 * than stacking on it: the route it came from renders against a session the
 * gateway refuses, and recovery stays latched off until a repair seeds a fresh
 * bearer, so Back would return the user to a dead page that cannot heal.
 */
export function useGuardianRepairRoute(): void {
  const navigate = useNavigate();
  useBusSubscription("gateway.guardian-repair-required", () => {
    void navigate(routes.selectAssistant, { replace: true });
  });
}

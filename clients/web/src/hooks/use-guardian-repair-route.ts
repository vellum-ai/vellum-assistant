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
 * on the repair from whichever route it was on.
 */
export function useGuardianRepairRoute(): void {
  const navigate = useNavigate();
  useBusSubscription("gateway.guardian-repair-required", () => {
    void navigate(routes.selectAssistant);
  });
}

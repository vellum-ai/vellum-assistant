import { useEffect } from "react";
import { useNavigate } from "react-router";

import { subscribeGatewayRepairRequired } from "@/assistant/gateway-repair-bus";
import { routes } from "@/utils/routes";

/**
 * Sends the session to the assistant chooser when the local gateway rejects it
 * past what the renderer can repair.
 *
 * The chooser's connect path is the one place that offers the guardian
 * re-provision, and its auto-connect reaches that dialog without a click when
 * a single assistant is installed. The rejected gateway token is already
 * cleared by the time this fires, so the connect mints a fresh one instead of
 * replaying the token the gateway refuses.
 *
 * Mounted once in `RootLayout`, so a session that dies mid-conversation lands
 * on the repair from whichever route it was on.
 */
export function useGatewayRepairRoute(): void {
  const navigate = useNavigate();
  useEffect(
    () =>
      subscribeGatewayRepairRequired(() => {
        void navigate(routes.selectAssistant);
      }),
    [navigate],
  );
}

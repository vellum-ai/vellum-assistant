import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  closeAppRoute,
  navigateFromApp,
} from "@/utils/conversation-navigation";

interface UseAppViewerRouteHandlersResult {
  handleCloseApp: () => void;
  handleNavigateAppRoute: (href: string) => void;
}

/**
 * The app viewer's route handlers: dismiss the app back to its conversation,
 * and follow a link out of the app. Every surface hosting the viewer shares
 * them, so closing and linking behave the same wherever the app is on screen.
 *
 * Both callbacks are stable for a given router, which keeps the viewer's
 * sandbox message bridge from re-arming on every render.
 */
export function useAppViewerRouteHandlers(): UseAppViewerRouteHandlersResult {
  const navigate = useNavigate();
  // `location.state` is referentially stable within an entry, so the callback
  // identity promise below holds.
  const { state } = useLocation();

  const handleCloseApp = useCallback(() => {
    closeAppRoute(navigate, { state });
  }, [navigate, state]);

  const handleNavigateAppRoute = useCallback(
    (href: string) => {
      navigateFromApp(navigate, href);
    },
    [navigate],
  );

  return { handleCloseApp, handleNavigateAppRoute };
}

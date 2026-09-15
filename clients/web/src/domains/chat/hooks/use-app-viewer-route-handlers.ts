import { useCallback } from "react";
import { useNavigate } from "react-router";

import {
  closeAppRoute,
  navigateFromApp,
} from "@/utils/conversation-navigation";

interface UseAppViewerRouteHandlersOptions {
  /** Close by replacing the history entry rather than pushing one. */
  replaceOnClose?: boolean;
}

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
export function useAppViewerRouteHandlers(
  options?: UseAppViewerRouteHandlersOptions,
): UseAppViewerRouteHandlersResult {
  const navigate = useNavigate();
  const replaceOnClose = options?.replaceOnClose === true;

  const handleCloseApp = useCallback(() => {
    closeAppRoute(navigate, { replace: replaceOnClose });
  }, [navigate, replaceOnClose]);

  const handleNavigateAppRoute = useCallback(
    (href: string) => {
      navigateFromApp(navigate, href);
    },
    [navigate],
  );

  return { handleCloseApp, handleNavigateAppRoute };
}

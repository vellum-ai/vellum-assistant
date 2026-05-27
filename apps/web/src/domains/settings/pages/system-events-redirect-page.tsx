import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * System Events moved out of Settings and into the Logs & Usage page.
 * Keep this route as a permanent redirect so existing bookmarks and
 * shared links continue to reach the same view.
 */
export function SystemEventsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.logs.systemEvents, { replace: true });
  }, [navigate]);

  return null;
}

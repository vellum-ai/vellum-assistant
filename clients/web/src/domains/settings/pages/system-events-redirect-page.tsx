import { useEffect } from "react";
import { useNavigate } from "react-router";

/**
 * System Events moved from a standalone Settings page → Logs overlay →
 * Debug (Advanced) page in-page tab. Keep this route as a permanent
 * redirect so existing bookmarks and shared links continue to reach
 * the same view.
 */
export function SystemEventsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate("/assistant/settings/debug?tab=system-events", { replace: true });
  }, [navigate]);

  return null;
}

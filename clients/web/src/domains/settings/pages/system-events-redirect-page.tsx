import { useEffect } from "react";
import { useNavigate } from "react-router";

/**
 * Permanent redirect: legacy /assistant/settings/system-events →
 * /assistant/settings/debug?tab=system-events so existing bookmarks
 * and shared links continue to reach the same view.
 */
export function SystemEventsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate("/assistant/settings/debug?tab=system-events", { replace: true });
  }, [navigate]);

  return null;
}

import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Legacy `/assistant/settings/keyboard-shortcuts` deep links land here; the
 * page's content now lives in the Preferences modal on Settings → General.
 */
export function KeyboardShortcutsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.general, { replace: true });
  }, [navigate]);

  return null;
}

import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Forwards legacy `/assistant/settings/keyboard-shortcuts` deep links to
 * Settings → General, where the Preferences modal hosts shortcut rebinding.
 */
export function KeyboardShortcutsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.general, { replace: true });
  }, [navigate]);

  return null;
}

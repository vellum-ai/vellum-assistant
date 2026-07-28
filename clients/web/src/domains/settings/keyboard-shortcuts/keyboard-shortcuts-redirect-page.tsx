import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Forwards legacy `/assistant/settings/keyboard-shortcuts` deep links to
 * Settings → General with the Preferences modal open, which hosts the
 * shortcut rebinding controls.
 */
export function KeyboardShortcutsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`${routes.settings.general}?preferences=open`, { replace: true });
  }, [navigate]);

  return null;
}

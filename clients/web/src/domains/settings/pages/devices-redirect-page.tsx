import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Forwards legacy `/assistant/settings/devices` deep links to
 * Settings → General; there is no Self-Hosted Assistants settings page.
 */
export function DevicesRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.general, { replace: true });
  }, [navigate]);

  return null;
}

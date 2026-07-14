import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Legacy `/assistant/settings/devices` deep links land here; the
 * Self-Hosted Assistants page was retired from Settings.
 */
export function DevicesRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.general, { replace: true });
  }, [navigate]);

  return null;
}

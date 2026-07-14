import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Legacy `/assistant/settings/sounds` deep links land here; the page's
 * content now lives on Settings → Voice & Sounds under the Sounds tab.
 */
export function SoundsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`${routes.settings.voice}?tab=sounds`, { replace: true });
  }, [navigate]);

  return null;
}

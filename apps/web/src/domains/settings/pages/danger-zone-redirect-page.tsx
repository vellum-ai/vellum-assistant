import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

export function DangerZoneRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.general, { replace: true });
  }, [navigate]);

  return null;
}

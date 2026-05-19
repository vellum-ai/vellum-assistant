import { Navigate } from "react-router";
import { SoundsPanel } from "@/components/app/settings/SoundsPanel.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { routes } from "@/lib/routes.js";

export default function SoundsSettingsPage() {
  const flags = useAppFeatureFlags();
  const sounds = flags["sounds"] ?? true;
  if (!sounds) {
    return <Navigate to={routes.settings.general} replace />;
  }
  return <SoundsPanel />;
}

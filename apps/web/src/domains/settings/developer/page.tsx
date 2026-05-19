import { Navigate } from "react-router";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { routes } from "@/lib/routes.js";
import { DeveloperSettingsContent } from "@/domains/settings/developer/_components/developer-settings-content.js";

export default function DeveloperSettingsPage() {
  const flags = useAppFeatureFlags();
  const developerSettings = flags.developerSettings ?? false;
  if (!developerSettings) {
    return <Navigate to={routes.settings.root} replace />;
  }
  return <DeveloperSettingsContent />;
}

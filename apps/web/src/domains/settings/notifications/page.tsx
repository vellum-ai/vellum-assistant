import { Navigate } from "react-router";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { routes } from "@/lib/routes.js";
import { NotificationsSettingsPageClient } from "@/domains/settings/notifications/NotificationsSettingsPageClient.js";

export default function NotificationsSettingsPage() {
  const flags = useAppFeatureFlags();
  const platformNotifications = flags.platformNotifications ?? false;
  if (!platformNotifications) {
    return <Navigate to={routes.settings.general} replace />;
  }
  return <NotificationsSettingsPageClient />;
}

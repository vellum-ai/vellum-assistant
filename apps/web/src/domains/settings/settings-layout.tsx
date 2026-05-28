import { useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { SETTINGS_SIDEBAR } from "@/domains/settings/navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree } from "@/components/sidebar-tree";
import { useSettingsSync } from "@/domains/settings/hooks/use-settings-sync";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SidebarShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 * Also mounts the settings sync bridge to keep TanStack Query caches
 * fresh while the user is on any settings page.
 */
export function SettingsLayout() {
  const settingsDeveloperNav = useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const platformNotifications = useClientFeatureFlagStore.use.platformNotifications();
  const sounds = useAssistantFeatureFlagStore.use.sounds();
  const { pathname } = useLocation();

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        if (item.id === "notifications" && !platformNotifications) {
          return false;
        }
        if (item.id === "sounds" && !sounds) {
          return false;
        }
        if (item.id === "developer") {
          return false;
        }
        return true;
      }),
    [platformNotifications, sounds],
  );

  const bottomItems = useMemo(
    () =>
      settingsDeveloperNav
        ? SETTINGS_SIDEBAR.filter((item) => item.id === "developer")
        : [],
    [settingsDeveloperNav],
  );

  const pageTitle = useMemo(() => {
    if (pathname === routes.settings.root) return "Settings";
    const match = SETTINGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) return match.label;
    return "Settings";
  }, [pathname]);

  useSettingsSync();

  return (
    <SidebarShell
      backHref={routes.assistant}
      sidebar={
        <SidebarTree items={filteredItems} bottomItems={bottomItems} />
      }
      title={pageTitle}
    >
      <Outlet />
    </SidebarShell>
  );
}

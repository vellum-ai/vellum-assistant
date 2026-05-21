import { useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { useFeatureFlagStore } from "@/lib/feature-flags/feature-flag-store.js";
import { routes } from "@/utils/routes.js";
import { SETTINGS_SIDEBAR } from "@/domains/settings/navigation.js";
import { SettingsShell } from "@/domains/settings/components/settings-shell.js";
import { SettingsSidebarTree } from "@/domains/settings/components/settings-sidebar-tree.js";
import { useSettingsSync } from "@/domains/settings/hooks/use-settings-sync.js";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SettingsShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 * Also mounts the settings sync bridge to keep TanStack Query caches
 * fresh while the user is on any settings page.
 */
export function SettingsLayout() {
  const settingsDeveloperNav = useFeatureFlagStore.use.settingsDeveloperNav();
  const platformNotifications = useFeatureFlagStore.use.platformNotifications();
  const sounds = useFeatureFlagStore.use.sounds();
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
    const match = SETTINGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) return match.label;
    // Index route (/assistant/settings) renders GeneralPage but doesn't
    // match any sidebar href — use the first sidebar item's label.
    if (pathname === routes.settings.root) {
      return SETTINGS_SIDEBAR[0]?.label ?? "Settings";
    }
    return "Settings";
  }, [pathname]);

  useSettingsSync();

  return (
    <SettingsShell
      backHref={routes.assistant}
      sidebar={
        <SettingsSidebarTree items={filteredItems} bottomItems={bottomItems} />
      }
      title={pageTitle}
    >
      <Outlet />
    </SettingsShell>
  );
}

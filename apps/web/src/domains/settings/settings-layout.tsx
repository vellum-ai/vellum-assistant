import { LogOut } from "lucide-react";
import { useMemo } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { usePlatformGate } from "@/hooks/use-platform-gate";
import { handleLogout } from "@/lib/auth/handle-logout";
import { isLocalMode } from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { SETTINGS_SIDEBAR } from "@/utils/settings-navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree, type SidebarItem } from "@/components/sidebar-tree";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SidebarShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 */
export function SettingsLayout() {
  const settingsDeveloperNav = useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const platformNotifications = useClientFeatureFlagStore.use.platformNotifications();
  const bookmarksEnabled = useClientFeatureFlagStore.use.bookmarks();
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingGate = usePlatformGate();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Hide logout in pure local mode unless a platform session exists.
  const hasPlatformSession = useHasPlatformSession();
  const showLogout = !isLocalMode() || hasPlatformSession;

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        if (
          item.id === "notifications" &&
          (!platformNotifications || platformGate === "gated")
        ) {
          return false;
        }
        if (item.id === "billing" && billingGate !== "full") {
          return false;
        }
        if (item.id === "bookmarks" && !bookmarksEnabled) {
          return false;
        }
        if (item.id === "devices" && platformGate === "gated") {
          return false;
        }
        // Hotkey rebinding drives Electron globalShortcut + menu accelerators,
        // which have no web/iOS analogue. Hide the entry off the desktop app;
        // the page itself also redirects as defense in depth.
        if (item.id === "keyboard-shortcuts" && !isElectron()) {
          return false;
        }
        if (item.id === "developer") {
          return false;
        }
        return true;
      }),
    [platformNotifications, platformGate, billingGate, bookmarksEnabled],
  );

  const bottomItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = [];
    if (settingsDeveloperNav) {
      items.push(...SETTINGS_SIDEBAR.filter((item) => item.id === "developer"));
    }
    // Log Out is pinned to the very bottom of the nav as an action item.
    if (showLogout) {
      items.push({
        id: "logout",
        label: "Log Out",
        icon: LogOut,
        onSelect: () => void handleLogout(navigate),
      });
    }
    return items;
  }, [settingsDeveloperNav, showLogout, navigate]);

  const pageTitle = useMemo(() => {
    if (pathname === routes.settings.root) return "Settings";
    const match = SETTINGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) return match.label;
    return "Settings";
  }, [pathname]);

  return (
    <SidebarShell
      backHref={routes.assistant}
      sidebar={
        <SidebarTree items={filteredItems} bottomItems={bottomItems} indexPath={routes.settings.root} />
      }
      title={pageTitle}
    >
      <Outlet />
    </SidebarShell>
  );
}

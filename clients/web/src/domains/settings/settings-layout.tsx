import { LogIn, LogOut } from "lucide-react";
import { useMemo } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { handleLogout } from "@/lib/auth/handle-logout";
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
  const credentialsSettingsEnabled = useAssistantFeatureFlagStore.use.credentialsSettings();
  const platformNotifications = useClientFeatureFlagStore.use.platformNotifications();
  const bookmarksEnabled = useClientFeatureFlagStore.use.bookmarks();
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingGate = usePlatformGate();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Show Log Out when a platform session exists, Log In otherwise.
  const hasPlatformSession = useHasPlatformSession();
  const { login } = useOnboardingLogin();

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
        if (item.id === "credentials" && !credentialsSettingsEnabled) {
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
    [platformNotifications, platformGate, billingGate, bookmarksEnabled, credentialsSettingsEnabled],
  );

  const bottomItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = [];
    if (settingsDeveloperNav) {
      items.push(...SETTINGS_SIDEBAR.filter((item) => item.id === "developer"));
    }
    // The auth action is pinned to the very bottom of the nav.
    items.push(
      hasPlatformSession
        ? {
            id: "logout",
            label: "Log Out",
            icon: LogOut,
            onSelect: () => void handleLogout(navigate),
          }
        : {
            id: "login",
            label: "Log In",
            icon: LogIn,
            onSelect: () => void login(),
          },
    );
    return items;
  }, [settingsDeveloperNav, hasPlatformSession, navigate, login]);

  const pageTitle = useMemo(() => {
    if (pathname === routes.settings.root) {return "Settings";}
    const match = SETTINGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) {return match.label;}
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

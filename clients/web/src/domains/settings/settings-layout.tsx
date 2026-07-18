import { LogIn, LogOut } from "lucide-react";
import { useMemo } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { handleLogout } from "@/lib/auth/handle-logout";
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
  // The Usage item is never hidden: the Usage tab reads from the local daemon
  // and works for every assistant. Its label only gains "Billing &" when the
  // Billing tab is actually shown — i.e. signed in to the Vellum platform
  // (`usePlatformGate() === "full"`), matching billing-page.tsx's
  // `showBillingTab`. Signed-out / self-hosted users see just "Usage".
  const billingGate = usePlatformGate();
  const billingLabel = billingGate === "full" ? "Billing & Usage" : "Usage";
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
        if (item.id === "bookmarks" && !bookmarksEnabled) {
          return false;
        }
        if (item.id === "credentials" && !credentialsSettingsEnabled) {
          return false;
        }
        if (item.id === "developer") {
          return false;
        }
        return true;
      }).map((item) =>
        item.id === "billing" ? { ...item, label: billingLabel } : item,
      ),
    [
      platformNotifications,
      platformGate,
      bookmarksEnabled,
      credentialsSettingsEnabled,
      billingLabel,
    ],
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
    if (match) {return match.id === "billing" ? billingLabel : match.label;}
    return "Settings";
  }, [pathname, billingLabel]);

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

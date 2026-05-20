import { createBrowserRouter, useNavigate } from "react-router";

import { authMiddleware } from "@/lib/auth/auth-middleware.js";
import { RootLayout } from "@/components/layout/root-layout.js";
import { ChatLayout } from "@/domains/chat/chat-layout.js";
import { ChatPage } from "@/domains/chat/chat-page.js";
import { HomePage } from "@/domains/home/home-page.js";
import { LibraryPage } from "@/domains/library/library-page.js";
import { LibraryDetailPage } from "@/domains/library/library-detail-page.js";
import { NotFound } from "@/components/not-found.js";
import { SettingsLayout } from "@/domains/settings/settings-layout.js";
import { GeneralPage } from "@/domains/settings/pages/general-page.js";
import { AiPage } from "@/domains/settings/ai/ai-page.js";
import { IntegrationsPage } from "@/domains/settings/pages/integrations-page.js";
import { SchedulesPage } from "@/domains/settings/pages/schedules-page.js";
import { NotificationsPage } from "@/domains/settings/pages/notifications-page.js";
import { SoundsPage } from "@/domains/settings/pages/sounds-page.js";
import { VoicePage } from "@/domains/settings/pages/voice-page.js";
import { DevicesPage } from "@/domains/settings/pages/devices-page.js";
import { PrivacyPage } from "@/domains/settings/pages/privacy-page.js";
import { ArchivePage } from "@/domains/settings/pages/archive-page.js";
import { CommunityPage } from "@/domains/settings/pages/community-page.js";
import { DebugPage } from "@/domains/settings/pages/debug-page.js";
import { DeveloperPage } from "@/domains/settings/pages/developer-page.js";
import { AdvancedPage } from "@/domains/settings/pages/advanced-page.js";
import { BillingPage } from "@/domains/settings/billing/billing-page.js";
import { BillingOnboardingPage } from "@/domains/settings/billing/onboarding-page.js";
import { UpgradeCancelPage } from "@/domains/settings/billing/upgrade-cancel-page.js";
import { UpgradeSuccessPage } from "@/domains/settings/billing/upgrade-success-page.js";
import { DangerZoneRedirectPage } from "@/domains/settings/pages/danger-zone-redirect-page.js";
import { SystemEventsRedirectPage } from "@/domains/settings/pages/system-events-redirect-page.js";
import { AccountPage } from "@/domains/account/pages/account-page.js";
import { LoginPage } from "@/domains/account/pages/login-page.js";
import { SignupPage } from "@/domains/account/pages/signup-page.js";
import { ProviderCallbackPage } from "@/domains/account/pages/provider-callback-page.js";
import { ProviderSignupPage } from "@/domains/account/pages/provider-signup-page.js";
import { DesktopOAuthCompletePage } from "@/domains/account/pages/desktop-oauth-complete-page.js";
import { LogoutPage } from "@/domains/account/pages/logout-page.js";
import { OAuthPopupCompletePage } from "@/domains/account/pages/oauth-popup-complete-page.js";
import { PasswordResetPage } from "@/domains/account/pages/password-reset-page.js";
import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { HatchingScreen } from "@/domains/onboarding/pages/hatching-screen.js";
import { PreChatFlow } from "@/domains/onboarding/pages/pre-chat-flow.js";
import { PrivacyScreen } from "@/domains/onboarding/pages/privacy-screen.js";
import { routes } from "@/utils/routes.js";

function HomePageRoute() {
  const navigate = useNavigate();
  const { assistantId } = useAssistantContext();
  return (
    <HomePage
      assistantId={assistantId}
      onStartNewChat={() => navigate(routes.assistant)}
      onOpenConversation={(conversationId) =>
        navigate(`${routes.assistant}/conversations/${conversationId}`)
      }
      onSuggestionSelected={(prompt) =>
        navigate(`${routes.assistant}?prompt=${encodeURIComponent(prompt)}`)
      }
    />
  );
}

/**
 * Route hierarchy (no basename — routes are absolute browser paths):
 *
 *   /account/*   — standalone auth pages, no app chrome
 *   │  ├── AccountPage (/account)
 *   │  ├── LoginPage (/account/login)
 *   │  ├── SignupPage (/account/signup)
 *   │  ├── ProviderCallbackPage (/account/provider/callback)
 *   │  ├── ProviderSignupPage (/account/provider/signup)
 *   │  ├── OAuthPopupCompletePage (/account/oauth/popup-complete)
 *   │  ├── DesktopOAuthCompletePage (/account/oauth/desktop-complete)
 *   │  ├── PasswordResetPage (/account/password/reset → redirects to login)
 *   │  └── PasswordResetPage (/account/password/reset/key/:key → redirects to login)
 *   │
 *   /logout        — standalone logout (calls API, redirects to login)
 *   │
 *   /assistant/* — auth-protected app with RootLayout
 *   │  middleware: [authMiddleware] — redirects to login when auth required
 *   │  ├── Onboarding (no ChatLayout chrome)
 *   │  │   ├── PrivacyScreen (/assistant/onboarding/privacy)
 *   │  │   ├── PreChatFlow (/assistant/onboarding/prechat)
 *   │  │   └── HatchingScreen (/assistant/onboarding/hatching)
 *   │  └── ChatLayout — sidebar rail, drawer, shortcuts
 *   │       ├── ChatPage (index, /assistant)
 *   │       ├── HomePageRoute (/assistant/home)
 *   │       ├── LibraryPage / LibraryDetailPage
 *   │       └── SettingsLayout (/assistant/settings)
 *   │            ├── GeneralPage (/assistant/settings/general)
 *   │            ├── AiPage (/assistant/settings/ai)
 *   │            ├── IntegrationsPage, SchedulesPage, ...
 *   │            ├── BillingPage (/assistant/settings/billing)
 *   │            │   ├── onboarding, upgrade/cancel, upgrade/success
 *   │            └── AdvancedPage, DeveloperPage, DebugPage
 *
 * References:
 * - React Router data mode routing: https://reactrouter.com/start/data/routing
 * - React Router prefix routes: https://reactrouter.com/start/data/routing#prefix-route
 * - React Router middleware: https://reactrouter.com/how-to/middleware
 */
export const router = createBrowserRouter([
  // Account routes — standalone auth pages, no app chrome
  {
    path: "/account",
    children: [
      { index: true, element: <AccountPage /> },
      { path: "login", element: <LoginPage /> },
      { path: "signup", element: <SignupPage /> },
      { path: "provider/callback", element: <ProviderCallbackPage /> },
      { path: "provider/signup", element: <ProviderSignupPage /> },
      { path: "oauth/popup-complete", element: <OAuthPopupCompletePage /> },
      { path: "oauth/desktop-complete", element: <DesktopOAuthCompletePage /> },
      { path: "password/reset", element: <PasswordResetPage /> },
      { path: "password/reset/key/:key", element: <PasswordResetPage /> },
    ],
  },

  // Logout — standalone page, no app chrome
  { path: "/logout", element: <LogoutPage /> },

  // Assistant routes — auth-protected app with layout
  {
    path: "/assistant",
    middleware: [authMiddleware],
    element: <RootLayout />,
    children: [
      // Onboarding routes — full-screen (no ChatLayout sidebar)
      { path: "onboarding/privacy", element: <PrivacyScreen /> },
      { path: "onboarding/prechat", element: <PreChatFlow /> },
      { path: "onboarding/hatching", element: <HatchingScreen /> },

      {
        element: <ChatLayout />,
        children: [
          { index: true, element: <ChatPage /> },
          { path: "home", element: <HomePageRoute /> },
          {
            path: "settings",
            element: <SettingsLayout />,
            children: [
              { index: true, element: <GeneralPage /> },
              { path: "general", element: <GeneralPage /> },
              { path: "ai", element: <AiPage /> },
              { path: "integrations", element: <IntegrationsPage /> },
              { path: "schedules", element: <SchedulesPage /> },
              { path: "notifications", element: <NotificationsPage /> },
              { path: "sounds", element: <SoundsPage /> },
              { path: "voice", element: <VoicePage /> },
              { path: "devices", element: <DevicesPage /> },
              { path: "privacy", element: <PrivacyPage /> },
              { path: "archive", element: <ArchivePage /> },
              { path: "billing", element: <BillingPage /> },
              { path: "billing/onboarding", element: <BillingOnboardingPage /> },
              { path: "billing/upgrade/cancel", element: <UpgradeCancelPage /> },
              { path: "billing/upgrade/success", element: <UpgradeSuccessPage /> },
              { path: "community", element: <CommunityPage /> },
              { path: "debug", element: <DebugPage /> },
              { path: "developer", element: <DeveloperPage /> },
              { path: "advanced", element: <AdvancedPage /> },
              { path: "danger-zone", element: <DangerZoneRedirectPage /> },
              { path: "system-events", element: <SystemEventsRedirectPage /> },
            ],
          },
          { path: "library", element: <LibraryPage /> },
          { path: "library/:appId", element: <LibraryDetailPage /> },
        ],
      },

      // Catch-all within /assistant/*
      { path: "*", element: <NotFound /> },
    ],
  },

  // Top-level catch-all
  { path: "*", element: <NotFound /> },
], {
  future: { v8_middleware: true },
});

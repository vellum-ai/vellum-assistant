import { createBrowserRouter, Navigate, useNavigate, useSearchParams } from "react-router";

import { authMiddleware } from "@/lib/auth/auth-middleware.js";
import { RootLayout } from "@/root-layout.js";
import { ChatLayout } from "@/domains/chat/chat-layout.js";
import { ChatPage } from "@/domains/chat/chat-page.js";
import { DocumentViewerPage } from "@/domains/chat/document-viewer-page.js";
import { HomePage } from "@/domains/home/home-page.js";
import { LibraryPage } from "@/domains/library/library-page.js";
import { LibraryDetailPage } from "@/domains/library/library-detail-page.js";
import { IdentityPage } from "@/domains/intelligence/identity-page.js";
import { IntelligenceLayout } from "@/domains/intelligence/intelligence-layout.js";
import { SkillsPage } from "@/domains/intelligence/skills-page.js";
import { ConnectPage } from "@/domains/contacts/connect-page.js";
import { ContactsPage } from "@/domains/contacts/contacts-page.js";
import { WorkspacePage } from "@/domains/workspace/workspace-page.js";
import { InspectPage } from "@/domains/chat/inspector/inspect-page.js";
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
import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import { ActiveAssistantGate } from "@/components/layout/active-assistant-gate.js";
import { HatchingScreen } from "@/domains/onboarding/pages/hatching-screen.js";
import { PreChatFlow } from "@/domains/onboarding/pages/pre-chat-flow.js";
import { PrivacyScreen } from "@/domains/onboarding/pages/privacy-screen.js";
import { LogsLayout } from "@/domains/logs/logs-layout.js";
import { TracePage } from "@/domains/logs/pages/trace-page.js";
import { UsagePage } from "@/domains/logs/pages/usage-page.js";
import { SystemEventsPage } from "@/domains/logs/pages/system-events-page.js";
import { EmailsPage } from "@/domains/logs/pages/emails-page.js";
import { routes } from "@/utils/routes.js";

/**
 * Handles the `/assistant` index route. If a legacy `?conversationKey=` search
 * param is present, redirects to the canonical path-based conversation URL.
 * Otherwise renders `ChatPage` (new/default conversation).
 */
function ConversationKeyRedirect() {
  const [searchParams] = useSearchParams();
  const conversationKey = searchParams.get("conversationKey");
  if (conversationKey) {
    const remaining = new URLSearchParams(searchParams);
    remaining.delete("conversationKey");
    const qs = remaining.toString();
    return <Navigate to={`${routes.conversation(conversationKey)}${qs ? `?${qs}` : ""}`} replace />;
  }
  return <ChatPage />;
}

function HomePageRoute() {
  const navigate = useNavigate();
  const { assistantId } = useActiveAssistantContext();
  return (
    <HomePage
      assistantId={assistantId}
      onStartNewChat={() => navigate(routes.assistant)}
      onOpenConversation={(conversationId) =>
        navigate(routes.conversation(conversationId))
      }
      onSuggestionSelected={(prompt) =>
        navigate(`${routes.assistant}?prompt=${encodeURIComponent(prompt)}`)
      }
    />
  );
}

// Route tree — no basename, routes are absolute browser paths.
// To view the full hierarchy at a glance:
//   grep -n 'path:' apps/web/src/routes.tsx
//
// References:
// - React Router data mode routing: https://reactrouter.com/start/data/routing
// - React Router middleware: https://reactrouter.com/how-to/middleware
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

      // Settings routes — full-screen overlay panel (no ChatLayout sidebar).
      // SettingsShell provides its own layout with back-arrow, sidebar nav,
      // and content area — the main app sidebar is intentionally hidden.
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

      // Logs routes — full-screen overlay panel (like SettingsLayout).
      // LogsLayout reuses SettingsShell for visual consistency.
      {
        path: "logs",
        element: <LogsLayout />,
        children: [
          { index: true, element: <UsagePage /> },
          { path: "trace", element: <TracePage /> },
          { path: "usage", element: <UsagePage /> },
          { path: "system-events", element: <SystemEventsPage /> },
          { path: "emails", element: <EmailsPage /> },
        ],
      },

      {
        element: <ChatLayout />,
        children: [
          // ChatPage / DocumentViewerPage own their own lifecycle UI
          // (loading screens, hatching, version-selection, errors) and
          // must render in every assistant state — they are NOT placed
          // under <ActiveAssistantGate>.
          { index: true, element: <ConversationKeyRedirect /> },
          { path: "conversations/:conversationKey", element: <ChatPage /> },
          { path: "documents/:surfaceId", element: <DocumentViewerPage /> },
          // Everything below requires a resolved assistantId AND an
          // active daemon. The gate defers child rendering until the
          // lifecycle resolves so route components can rely on a
          // non-null assistantId via useActiveAssistantContext().
          {
            element: <ActiveAssistantGate />,
            children: [
              { path: "home", element: <HomePageRoute /> },
              {
                element: <IntelligenceLayout />,
                children: [
                  { path: "identity", element: <IdentityPage /> },
                  { path: "skills", element: <SkillsPage /> },
                  { path: "library", element: <LibraryPage /> },
                  { path: "workspace", element: <WorkspacePage /> },
                  { path: "contacts", element: <ContactsPage /> },
                ],
              },
              { path: "library/:appId", element: <LibraryDetailPage /> },
              { path: "connect", element: <ConnectPage /> },
              { path: "inspect", element: <InspectPage /> },
            ],
          },
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

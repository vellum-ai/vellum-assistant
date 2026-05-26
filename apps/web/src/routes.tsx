import { createBrowserRouter } from "react-router";

import { authMiddleware } from "@/lib/auth/auth-middleware.js";
import { RootLayout } from "@/root-layout.js";
import { ChatLayout } from "@/domains/chat/chat-layout.js";
import { ChatPage } from "@/domains/chat/chat-page.js";
import { ConversationRedirect } from "@/domains/chat/conversation-redirect.js";
import { DocumentViewerPage } from "@/domains/chat/document-viewer-page.js";
import { HomePageRoute } from "@/home-page-route.js";
import { LibraryPage } from "@/domains/library/library-page.js";
import { LibraryDetailPage } from "@/domains/library/library-detail-page.js";
import { IdentityPage } from "@/domains/intelligence/identity-page.js";
import { IntelligenceLayout } from "@/domains/intelligence/intelligence-layout.js";
import { PluginsPage } from "@/domains/intelligence/plugins-page.js";
import { SkillsPage } from "@/domains/intelligence/skills-page.js";
import { ConnectPage } from "@/domains/contacts/connect-page.js";
import { ContactsPage } from "@/domains/contacts/contacts-page.js";
import { WorkspacePage } from "@/domains/workspace/workspace-page.js";
import { InspectPage } from "@/domains/chat/inspector/inspect-page.js";
import { MemoryRouterPlaygroundPage } from "@/domains/chat/inspector/memory-router-playground-page.js";
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
import { ActiveAssistantGate } from "@/components/layout/active-assistant-gate.js";
import { HatchingScreen } from "@/domains/onboarding/pages/hatching-screen.js";
import { PreChatFlow } from "@/domains/onboarding/pages/pre-chat-flow.js";
import { PrivacyScreen } from "@/domains/onboarding/pages/privacy-screen.js";
import { LogsLayout } from "@/domains/logs/logs-layout.js";
import { TracePage } from "@/domains/logs/pages/trace-page.js";
import { UsagePage } from "@/domains/logs/pages/usage-page.js";
import { SystemEventsPage } from "@/domains/logs/pages/system-events-page.js";
import { EmailsPage } from "@/domains/logs/pages/emails-page.js";

// Route tree — no basename, routes are absolute browser paths.
// To view the full hierarchy at a glance:
//   grep -n 'path:' apps/web/src/routes.tsx
//
// References:
// - React Router data mode routing: https://reactrouter.com/start/data/routing
// - React Router route object: https://reactrouter.com/start/data/route-object
// - React Router middleware: https://reactrouter.com/how-to/middleware
export const router = createBrowserRouter(
  [
    // Account routes — standalone auth pages, no app chrome
    {
      path: "/account",
      children: [
        { index: true, Component: AccountPage },
        { path: "login", Component: LoginPage },
        { path: "signup", Component: SignupPage },
        { path: "provider/callback", Component: ProviderCallbackPage },
        { path: "provider/signup", Component: ProviderSignupPage },
        { path: "oauth/popup-complete", Component: OAuthPopupCompletePage },
        { path: "oauth/desktop-complete", Component: DesktopOAuthCompletePage },
        { path: "password/reset", Component: PasswordResetPage },
        { path: "password/reset/key/:key", Component: PasswordResetPage },
      ],
    },

    // Logout — standalone page, no app chrome
    { path: "/logout", Component: LogoutPage },

    // Assistant routes — auth-protected app with layout
    {
      path: "/assistant",
      middleware: [authMiddleware],
      Component: RootLayout,
      children: [
        // Onboarding routes — full-screen (no ChatLayout sidebar)
        { path: "onboarding/privacy", Component: PrivacyScreen },
        { path: "onboarding/prechat", Component: PreChatFlow },
        { path: "onboarding/hatching", Component: HatchingScreen },

        // Settings routes — full-screen overlay panel (no ChatLayout sidebar).
        // SettingsShell provides its own layout with back-arrow, sidebar nav,
        // and content area — the main app sidebar is intentionally hidden.
        {
          path: "settings",
          Component: SettingsLayout,
          children: [
            { index: true, Component: GeneralPage },
            { path: "general", Component: GeneralPage },
            { path: "ai", Component: AiPage },
            { path: "integrations", Component: IntegrationsPage },
            { path: "schedules", Component: SchedulesPage },
            { path: "notifications", Component: NotificationsPage },
            { path: "sounds", Component: SoundsPage },
            { path: "voice", Component: VoicePage },
            { path: "devices", Component: DevicesPage },
            { path: "privacy", Component: PrivacyPage },
            { path: "archive", Component: ArchivePage },
            { path: "billing", Component: BillingPage },
            { path: "billing/upgrade/cancel", Component: UpgradeCancelPage },
            { path: "billing/upgrade/success", Component: UpgradeSuccessPage },
            { path: "community", Component: CommunityPage },
            { path: "debug", Component: DebugPage },
            { path: "developer", Component: DeveloperPage },
            { path: "advanced", Component: AdvancedPage },
            { path: "danger-zone", Component: DangerZoneRedirectPage },
            { path: "system-events", Component: SystemEventsRedirectPage },
          ],
        },

        // Logs routes — full-screen overlay panel (like SettingsLayout).
        // LogsLayout reuses SettingsShell for visual consistency.
        {
          path: "logs",
          Component: LogsLayout,
          children: [
            { index: true, Component: UsagePage },
            { path: "trace", Component: TracePage },
            { path: "usage", Component: UsagePage },
            { path: "system-events", Component: SystemEventsPage },
            { path: "emails", Component: EmailsPage },
          ],
        },

        {
          Component: ChatLayout,
          children: [
            // ChatPage / DocumentViewerPage own their own lifecycle UI
            // (loading screens, hatching, version-selection, errors) and
            // must render in every assistant state — they are NOT placed
            // under <ActiveAssistantGate>.
            { index: true, Component: ConversationRedirect },
            { path: "conversations/:conversationId", Component: ChatPage },
            { path: "documents/:surfaceId", Component: DocumentViewerPage },
            // Everything below requires a resolved assistantId AND an
            // active daemon. The gate defers child rendering until the
            // lifecycle resolves so route components can rely on a
            // non-null assistantId via useActiveAssistantContext().
            {
              Component: ActiveAssistantGate,
              children: [
                { path: "home", Component: HomePageRoute },
                {
                  Component: IntelligenceLayout,
                  children: [
                    { path: "identity", Component: IdentityPage },
                    { path: "plugins", Component: PluginsPage },
                    { path: "skills", Component: SkillsPage },
                    { path: "workspace", Component: WorkspacePage },
                    { path: "contacts", Component: ContactsPage },
                  ],
                },
                { path: "library", Component: LibraryPage },
                { path: "library/:appId", Component: LibraryDetailPage },
                { path: "connect", Component: ConnectPage },
                {
                  path: "conversations/:conversationId/inspect",
                  Component: InspectPage,
                },
                {
                  path: "memory-router-playground",
                  Component: MemoryRouterPlaygroundPage,
                },
              ],
            },
          ],
        },

        // Catch-all within /assistant/*
        { path: "*", Component: NotFound },
      ],
    },

    // Top-level catch-all
    { path: "*", Component: NotFound },
  ],
  {
    future: { v8_middleware: true },
  },
);

import { createBrowserRouter } from "react-router";

import { authMiddleware } from "@/lib/auth/auth-middleware";
import { RootLayout } from "@/root-layout";
import { ChatLayout } from "@/domains/chat/chat-layout";
import { ChatPage } from "@/domains/chat/chat-page";
import { ConversationRedirect } from "@/domains/chat/conversation-redirect";
import { DocumentViewerPage } from "@/domains/chat/document-viewer-page";
import { NotFound } from "@/components/not-found";
import { RootErrorBoundary } from "@/components/root-error-boundary";
import { ActiveAssistantGate } from "@/components/layout/active-assistant-gate";

// Route tree — no basename, routes are absolute browser paths.
// To view the full hierarchy at a glance:
//   grep -n 'path:' apps/web/src/routes.tsx
//
// Non-critical route groups use the object-based `lazy` property so Vite
// splits them into separate chunks that are fetched on first navigation.
// The router resolves each lazy property before transitioning, so the
// previous route stays visible while the new chunk downloads — no flash.
//
// References:
// - React Router data mode routing: https://reactrouter.com/start/data/routing
// - React Router route object: https://reactrouter.com/start/data/route-object
// - React Router lazy (data mode): https://reactrouter.com/start/data/custom#3-lazy-loading
// - React Router error boundaries: https://reactrouter.com/how-to/error-boundary
// - React Router middleware: https://reactrouter.com/how-to/middleware
export const router = createBrowserRouter(
  [
    // Account routes — standalone auth pages, no app chrome.
    // Lazy-loaded: only needed for unauthenticated flows.
    {
      path: "/account",
      ErrorBoundary: RootErrorBoundary,
      children: [
        { index: true, lazy: { Component: () => import("@/domains/account/pages/account-page").then((m) => m.AccountPage) } },
        { path: "login", lazy: { Component: () => import("@/domains/account/pages/login-page").then((m) => m.LoginPage) } },
        { path: "signup", lazy: { Component: () => import("@/domains/account/pages/signup-page").then((m) => m.SignupPage) } },
        { path: "provider/callback", lazy: { Component: () => import("@/domains/account/pages/provider-callback-page").then((m) => m.ProviderCallbackPage) } },
        { path: "provider/signup", lazy: { Component: () => import("@/domains/account/pages/provider-signup-page").then((m) => m.ProviderSignupPage) } },
        { path: "oauth/popup-complete", lazy: { Component: () => import("@/domains/account/pages/oauth-popup-complete-page").then((m) => m.OAuthPopupCompletePage) } },
        { path: "oauth/desktop-complete", lazy: { Component: () => import("@/domains/account/pages/desktop-oauth-complete-page").then((m) => m.DesktopOAuthCompletePage) } },
        { path: "password/reset", lazy: { Component: () => import("@/domains/account/pages/password-reset-page").then((m) => m.PasswordResetPage) } },
        { path: "password/reset/key/:key", lazy: { Component: () => import("@/domains/account/pages/password-reset-page").then((m) => m.PasswordResetPage) } },
      ],
    },

    // Logout — standalone page, no app chrome
    { path: "/logout", ErrorBoundary: RootErrorBoundary, lazy: { Component: () => import("@/domains/account/pages/logout-page").then((m) => m.LogoutPage) } },

    // Assistant routes — auth-protected app with layout
    {
      path: "/assistant",
      middleware: [authMiddleware],
      ErrorBoundary: RootErrorBoundary,
      Component: RootLayout,
      children: [
        // Onboarding routes — full-screen (no ChatLayout sidebar).
        // Lazy-loaded: one-time flow, not revisited.
        {
          path: "onboarding/privacy",
          lazy: { Component: () => import("@/domains/onboarding/pages/privacy-screen").then((m) => m.PrivacyScreen) },
        },
        {
          path: "onboarding/prechat",
          lazy: { Component: () => import("@/domains/onboarding/pages/pre-chat-flow").then((m) => m.PreChatFlow) },
        },
        {
          path: "onboarding/hatching",
          lazy: { Component: () => import("@/domains/onboarding/pages/hatching-screen").then((m) => m.HatchingScreen) },
        },

        // Settings routes — full-screen overlay panel (no ChatLayout sidebar).
        // SidebarShell provides its own layout with back-arrow, sidebar nav,
        // and content area — the main app sidebar is intentionally hidden.
        // Lazy-loaded: visited occasionally, heavy deps (Stripe, schedules, voice).
        {
          path: "settings",
          lazy: { Component: () => import("@/domains/settings/settings-layout").then((m) => m.SettingsLayout) },
          children: [
            { index: true, lazy: { Component: () => import("@/domains/settings/pages/general-page").then((m) => m.GeneralPage) } },
            { path: "general", lazy: { Component: () => import("@/domains/settings/pages/general-page").then((m) => m.GeneralPage) } },
            { path: "ai", lazy: { Component: () => import("@/domains/settings/ai/ai-page").then((m) => m.AiPage) } },
            { path: "integrations", lazy: { Component: () => import("@/domains/settings/pages/integrations-page").then((m) => m.IntegrationsPage) } },
            { path: "schedules", lazy: { Component: () => import("@/domains/settings/pages/schedules-page").then((m) => m.SchedulesPage) } },
            { path: "notifications", lazy: { Component: () => import("@/domains/settings/pages/notifications-page").then((m) => m.NotificationsPage) } },
            { path: "sounds", lazy: { Component: () => import("@/domains/settings/pages/sounds-page").then((m) => m.SoundsPage) } },
            { path: "voice", lazy: { Component: () => import("@/domains/settings/pages/voice-page").then((m) => m.VoicePage) } },
            { path: "devices", lazy: { Component: () => import("@/domains/settings/pages/devices-page").then((m) => m.DevicesPage) } },
            { path: "privacy", lazy: { Component: () => import("@/domains/settings/pages/privacy-page").then((m) => m.PrivacyPage) } },
            { path: "archive", lazy: { Component: () => import("@/domains/settings/pages/archive-page").then((m) => m.ArchivePage) } },
            { path: "billing", lazy: { Component: () => import("@/domains/settings/billing/billing-page").then((m) => m.BillingPage) } },
            { path: "billing/upgrade/cancel", lazy: { Component: () => import("@/domains/settings/billing/upgrade-cancel-page").then((m) => m.UpgradeCancelPage) } },
            { path: "billing/upgrade/success", lazy: { Component: () => import("@/domains/settings/billing/upgrade-success-page").then((m) => m.UpgradeSuccessPage) } },
            { path: "community", lazy: { Component: () => import("@/domains/settings/pages/community-page").then((m) => m.CommunityPage) } },
            { path: "debug", lazy: { Component: () => import("@/domains/settings/pages/debug-page").then((m) => m.DebugPage) } },
            { path: "developer", lazy: { Component: () => import("@/domains/settings/pages/developer-page").then((m) => m.DeveloperPage) } },
            { path: "advanced", lazy: { Component: () => import("@/domains/settings/pages/advanced-page").then((m) => m.AdvancedPage) } },
            { path: "danger-zone", lazy: { Component: () => import("@/domains/settings/pages/danger-zone-redirect-page").then((m) => m.DangerZoneRedirectPage) } },
            { path: "system-events", lazy: { Component: () => import("@/domains/settings/pages/system-events-redirect-page").then((m) => m.SystemEventsRedirectPage) } },
          ],
        },

        // Logs routes — full-screen overlay panel (like SettingsLayout).
        // LogsLayout reuses SidebarShell for visual consistency.
        // Lazy-loaded: analytics-only, pulls in recharts.
        {
          path: "logs",
          lazy: { Component: () => import("@/domains/logs/logs-layout").then((m) => m.LogsLayout) },
          children: [
            { index: true, lazy: { Component: () => import("@/domains/logs/pages/usage-page").then((m) => m.UsagePage) } },
            { path: "trace", lazy: { Component: () => import("@/domains/logs/pages/trace-page").then((m) => m.TracePage) } },
            { path: "usage", lazy: { Component: () => import("@/domains/logs/pages/usage-page").then((m) => m.UsagePage) } },
            { path: "system-events", lazy: { Component: () => import("@/domains/logs/pages/system-events-page").then((m) => m.SystemEventsPage) } },
            { path: "emails", lazy: { Component: () => import("@/domains/logs/pages/emails-page").then((m) => m.EmailsPage) } },
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
                {
                  path: "home",
                  lazy: { Component: () => import("@/home-page-route").then((m) => m.HomePageRoute) },
                },
                {
                  lazy: { Component: () => import("@/domains/intelligence/intelligence-layout").then((m) => m.IntelligenceLayout) },
                  children: [
                    { path: "identity", lazy: { Component: () => import("@/identity-page-route").then((m) => m.IdentityPageRoute) } },
                    { path: "plugins", lazy: { Component: () => import("@/domains/intelligence/plugins-page").then((m) => m.PluginsPage) } },
                    { path: "skills", lazy: { Component: () => import("@/domains/intelligence/skills-page").then((m) => m.SkillsPage) } },
                    { path: "workspace", lazy: { Component: () => import("@/domains/workspace/workspace-page").then((m) => m.WorkspacePage) } },
                    { path: "contacts", lazy: { Component: () => import("@/contacts-page-route").then((m) => m.ContactsPageRoute) } },
                  ],
                },
                { path: "library", lazy: { Component: () => import("@/domains/library/library-page").then((m) => m.LibraryPage) } },
                { path: "library/:appId", lazy: { Component: () => import("@/domains/library/library-detail-page").then((m) => m.LibraryDetailPage) } },
                { path: "connect", lazy: { Component: () => import("@/domains/contacts/connect-page").then((m) => m.ConnectPage) } },
                {
                  path: "conversations/:conversationId/inspect",
                  lazy: { Component: () => import("@/domains/chat/inspector/inspect-page").then((m) => m.InspectPage) },
                },
                {
                  path: "memory-router-playground",
                  lazy: { Component: () => import("@/domains/chat/inspector/memory-router-playground-page").then((m) => m.MemoryRouterPlaygroundPage) },
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
    { path: "*", ErrorBoundary: RootErrorBoundary, Component: NotFound },
  ],
  {
    future: { v8_middleware: true },
  },
);

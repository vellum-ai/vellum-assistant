import { createBrowserRouter, Navigate, useSearchParams } from "react-router";

import { authMiddleware } from "@/lib/auth/auth-middleware";
import {
  localModeOnlyMiddleware,
  onboardingCompletedMiddleware,
} from "@/lib/onboarding-middleware";
import { RootLayout } from "@/root-layout";
import { AccountLayout } from "@/domains/account/account-layout";
import { ChatLayout } from "@/domains/chat/chat-layout";
import { ChatPage } from "@/domains/chat/chat-page";
import { ConversationRedirect } from "@/domains/chat/conversation-redirect";
import { NotFound } from "@/components/not-found";
import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { RootHydrateFallback } from "@/components/root-hydrate-fallback";
import { ActiveAssistantGate } from "@/components/layout/active-assistant-gate";
import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import { routes } from "@/utils/routes";

/**
 * Redirects legacy `/account/oauth/desktop-complete` to the canonical
 * `/account/oauth/complete`, preserving all query parameters. Older macOS
 * and iOS Capacitor builds have the old path baked in.
 */
function OAuthDesktopCompleteRedirect() {
  const [searchParams] = useSearchParams();
  const qs = searchParams.toString();
  return (
    <Navigate
      to={`${routes.account.oauth.complete}${qs ? `?${qs}` : ""}`}
      replace
    />
  );
}

function McpSettingsRedirect() {
  return <Navigate to={`${routes.settings.integrations}?tab=mcp`} replace />;
}

/**
 * Forwards `/assistant/settings/debug` deep links to Settings → Advanced, which
 * hosts the General, Terminal, and Doctor tabs. The query string is preserved
 * so `?tab=terminal` and `?tab=doctor` land on the matching in-page tab.
 */
function DebugSettingsRedirect() {
  const [searchParams] = useSearchParams();
  const qs = searchParams.toString();
  return (
    <Navigate
      to={`${routes.settings.advanced}${qs ? `?${qs}` : ""}`}
      replace
    />
  );
}

export function getRouterBasename(): string | undefined {
  if (!isRemoteGatewayMode()) {return undefined;}
  return remoteGatewayPublicPathPrefix() || undefined;
}

// Route tree — no basename in normal app modes; remote-gateway mode adds the
// public path prefix as the router basename so Velay-style URLs such as
// `/assistant-123/assistant/pair` match the same `/assistant/*` route tree.
// To view the full hierarchy at a glance:
//   grep -n 'path:' clients/web/src/routes.tsx
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
// Exported separately from `router` so the route tree can be asserted in
// tests: `createBrowserRouter` consumes `Component`, so structural checks
// (e.g. "the OAuth popup pages are NOT under AccountLayout") must run against
// these raw definitions.
export const routeTree = [
    // Account routes — standalone auth pages, no app chrome.
    // Lazy-loaded: only needed for unauthenticated flows.
    {
      path: "/account",
      ErrorBoundary: RouteErrorBoundary,
      HydrateFallback: RootHydrateFallback,
      children: [
        // Pathless wrapper so lazy-chunk failures render the chunk-fail
        // variant of `RouteErrorBoundary` (inline copy + Reload button)
        // rather than the full-page variant inherited from the top.
        {
          ErrorBoundary: RouteErrorBoundary,
          children: [
            // Auth screens that render in the MAIN window. AccountLayout sizes
            // it compact (440×630) for these, matching onboarding.
            {
              Component: AccountLayout,
              children: [
                { index: true, lazy: { Component: () => import("@/domains/account/pages/account-page").then((m) => m.AccountPage) } },
                { path: "login", lazy: { Component: () => import("@/domains/account/pages/login-page").then((m) => m.LoginPage) } },
                { path: "signup", lazy: { Component: () => import("@/domains/account/pages/signup-page").then((m) => m.SignupPage) } },
                { path: "provider/callback", lazy: { Component: () => import("@/domains/account/pages/provider-callback-page").then((m) => m.ProviderCallbackPage) } },
                { path: "provider/signup", lazy: { Component: () => import("@/domains/account/pages/provider-signup-page").then((m) => m.ProviderSignupPage) } },
                { path: "password/reset", lazy: { Component: () => import("@/domains/account/pages/password-reset-page").then((m) => m.PasswordResetPage) } },
                { path: "password/reset/key/:key", lazy: { Component: () => import("@/domains/account/pages/password-reset-page").then((m) => m.PasswordResetPage) } },
              ],
            },
            // OAuth completion / loopback machinery. These render inside the
            // OAuth popup child window (or are transient redirects), NOT the
            // main window — so they're deliberately OUTSIDE AccountLayout and
            // never mount the sizing hook. The resize IPC targets the
            // module-scoped main window, so sizing from a popup would shrink
            // the wrong window. See `use-onboarding-window-size`.
            { path: "oauth/popup-complete", lazy: { Component: () => import("@/domains/account/pages/oauth-popup-complete-page").then((m) => m.OAuthPopupCompletePage) } },
            { path: "oauth/complete", lazy: { Component: () => import("@/domains/account/pages/oauth-complete-page").then((m) => m.OAuthCompletePage) } },
            { path: "oauth/desktop-complete", Component: OAuthDesktopCompleteRedirect },
            { path: "platform-callback", lazy: { Component: () => import("@/domains/account/pages/platform-loopback-page").then((m) => m.PlatformLoopbackPage) } },
          ],
        },
      ],
    },

    // Logout — standalone page, no app chrome
    { path: "/logout", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/domains/account/pages/logout-page").then((m) => m.LogoutPage) } },

    // About — standalone metadata page rendered inside the Electron
    // About BrowserWindow. Declared as a sibling of `/assistant` (not
    // a child) so React Router's most-specific matcher picks it for
    // `/assistant/about` BEFORE falling into the auth-protected app
    // tree below. URL sits under `/assistant/*` so it's served by
    // Vite's SPA fallback in dev (which is scoped to the `base`).
    { path: "/assistant/about", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/components/about-page").then((m) => m.AboutPage) } },

    // Bundle confirmation — standalone page rendered inside the Electron
    // bundle-confirmation BrowserWindow. No auth required so bundles can
    // be opened before the user logs in. Same sibling pattern as About.
    { path: "/assistant/bundle/confirm", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/pages/BundleConfirmPage").then((m) => m.BundleConfirmPage) } },

    // Remote web pairing — standalone page for the RFC8628-style browser
    // polling flow. It must stay outside the auth-protected app tree because
    // its job is to obtain the first in-memory gateway access token.
    { path: "/assistant/pair", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/domains/remote-web/pairing-page").then((m) => m.RemoteWebPairingPage) } },

    // One-time credential entry — public page opened from a single-use
    // credential-request link. Kept OUTSIDE the auth-protected tree (same
    // sibling pattern as /assistant/pair) because the recipient of the link
    // may have no Vellum session at all; the single-use token, sent in the
    // request body, is the only authorization the gateway needs.
    { path: "/assistant/credentials/enter", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/domains/credential-requests/credential-entry-page").then((m) => m.CredentialEntryPage) } },

    // Theme stage — deterministic compositions of the app's themeable
    // surfaces, rendered inside a hidden Electron BrowserWindow and
    // screenshotted for the `assistant ui snapshot` flow. Unauthenticated
    // and API-free (theme tokens arrive URL-encoded). Same sibling pattern
    // as About.
    { path: "/assistant/theme-stage/:view", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/components/theme-stage-page").then((m) => m.ThemeStagePage) } },

    // Quick Input — lightweight input panel rendered inside the Electron
    // quick input BrowserWindow (a frameless, always-on-top panel invoked
    // via Cmd+Shift+/). Same pattern as About: sibling of `/assistant`,
    // outside auth middleware and RootLayout for fast load.
    { path: "/assistant/quick-input", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/components/quick-input-page").then((m) => m.QuickInputPage) } },

    // Command palette — focused floating Electron BrowserWindow opened by
    // the app menu's Cmd/Ctrl+K accelerator. Standalone and unauthenticated
    // so it does not depend on ChatLayout being mounted in the main window.
    { path: "/assistant/floating/command-palette", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/components/command-palette/command-palette-window-page").then((m) => m.CommandPaletteWindowPage) } },

    // Dictation overlay — live transcription pill rendered inside the
    // Electron dictation overlay BrowserWindow (a floating panel pinned
    // top-center of the screen while push-to-talk dictation is active).
    // Same pattern as Quick Input: sibling of `/assistant`,
    // outside auth middleware and RootLayout for fast load.
    { path: "/assistant/floating/dictation-overlay", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/components/dictation-overlay-page").then((m) => m.DictationOverlayPage) } },
    // Legacy direct path retained so old dev windows do not blank during
    // rolling Electron/web updates.
    { path: "/assistant/dictation-overlay", ErrorBoundary: RouteErrorBoundary, HydrateFallback: RootHydrateFallback, lazy: { Component: () => import("@/components/dictation-overlay-page").then((m) => m.DictationOverlayPage) } },

    // Assistant routes — auth-protected app with layout
    {
      path: "/assistant",
      middleware: [authMiddleware],
      ErrorBoundary: RouteErrorBoundary,
      HydrateFallback: RootHydrateFallback,
      Component: RootLayout,
      children: [
        // Pathless wrapper attaching `RouteErrorBoundary` at the layer
        // *inside* RootLayout. Any error from a child route (chunk-fetch
        // failure or genuine render bug) is caught here — React Router
        // doesn't support selective bubbling. The boundary picks a UI
        // variant based on the error shape:
        //   - chunk fail  → inline "section couldn't load" within
        //                   RootLayout's chrome (sidebar stays visible)
        //   - other error → full-page "Something went wrong" treatment
        //                   (full-viewport `min-h-svh` so it reads as a
        //                   takeover even when mounted inside chrome)
        // The outer boundary on `/assistant` only fires for errors that
        // happen *during* the resolution of `/assistant` itself (loader,
        // middleware, RootLayout render) — not for child-route errors.
        {
          ErrorBoundary: RouteErrorBoundary,
          children: [
        // Standalone pre-app routes (not part of the new-user onboarding funnel).
        {
          path: "welcome",
          lazy: { Component: () => import("@/domains/onboarding/pages/welcome-screen").then((m) => m.WelcomeScreen) },
        },
        {
          path: "select-assistant",
          lazy: { Component: () => import("@/domains/onboarding/pages/select-assistant-screen").then((m) => m.SelectAssistantScreen) },
        },
        // SPIKE — research-onboarding front door. Placed here (not in the
        // onboarding funnel block) so it's reachable on demand behind auth
        // alone, without the onboarding-completed guard bouncing already-
        // onboarded users away. Visit `/assistant/onboarding/research`.
        {
          path: "onboarding/research",
          lazy: { Component: () => import("@/domains/onboarding/pages/research-onboarding-route").then((m) => m.ResearchOnboardingRoute) },
        },
        // SPIKE — mock harness for iterating on the research results UI without
        // running the real job. Static fixtures + local state.
        {
          path: "onboarding/research-mock",
          lazy: { Component: () => import("@/domains/chat/onboarding-research/research-mock-page").then((m) => m.ResearchMockPage) },
        },
        {
          path: "review-terms",
          lazy: { Component: () => import("@/domains/onboarding/pages/review-terms-screen").then((m) => m.ReviewTermsScreen) },
        },

        // Onboarding funnel — new-user setup flow (privacy → prechat → hatching).
        {
          middleware: [onboardingCompletedMiddleware],
          children: [
            {
              middleware: [localModeOnlyMiddleware],
              children: [
                {
                  path: "onboarding/hosting",
                  lazy: { Component: () => import("@/domains/onboarding/pages/hosting-screen").then((m) => m.HostingScreen) },
                },
                {
                  path: "onboarding/api-key",
                  lazy: { Component: () => import("@/domains/onboarding/pages/api-key-screen").then((m) => m.ApiKeyScreen) },
                },
              ],
            },
            {
              path: "onboarding/privacy",
              lazy: { Component: () => import("@/domains/onboarding/pages/privacy-screen").then((m) => m.PrivacyScreen) },
            },
            {
              path: "onboarding/prechat",
              lazy: { Component: () => import("@/domains/onboarding/pages/prechat-route").then((m) => m.PreChatRoute) },
            },
            {
              path: "onboarding/hatching",
              lazy: { Component: () => import("@/domains/onboarding/pages/hatching-screen").then((m) => m.HatchingScreen) },
            },
          ],
        },

        // Settings and logs require a resolved assistant. The gate
        // defers child rendering until the lifecycle reaches active/
        // self_hosted, so route components can use useActiveAssistantId().
        {
          Component: ActiveAssistantGate,
          children: [
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
                { path: "credentials", lazy: { Component: () => import("@/domains/settings/credentials/credentials-page").then((m) => m.CredentialsPage) } },
                { path: "notifications", lazy: { Component: () => import("@/domains/settings/pages/notifications-page").then((m) => m.NotificationsPage) } },
                { path: "keyboard-shortcuts", lazy: { Component: () => import("@/domains/settings/keyboard-shortcuts/keyboard-shortcuts-redirect-page").then((m) => m.KeyboardShortcutsRedirectPage) } },
                { path: "sounds", lazy: { Component: () => import("@/domains/settings/pages/sounds-redirect-page").then((m) => m.SoundsRedirectPage) } },
                { path: "voice", lazy: { Component: () => import("@/domains/settings/pages/voice-page").then((m) => m.VoicePage) } },
                { path: "devices", lazy: { Component: () => import("@/domains/settings/pages/devices-redirect-page").then((m) => m.DevicesRedirectPage) } },
                { path: "privacy", lazy: { Component: () => import("@/domains/settings/pages/privacy-page").then((m) => m.PrivacyPage) } },
                { path: "security", lazy: { Component: () => import("@/domains/settings/pages/security-redirect-page").then((m) => m.SecurityRedirectPage) } },
                { path: "archive", lazy: { Component: () => import("@/domains/settings/pages/archive-redirect-page").then((m) => m.ArchiveRedirectPage) } },
                { path: "bookmarks", lazy: { Component: () => import("@/domains/settings/pages/bookmarks-page").then((m) => m.BookmarksPage) } },
                { path: "billing", lazy: { Component: () => import("@/domains/settings/billing/billing-page").then((m) => m.BillingPage) } },
                { path: "billing/upgrade/cancel", lazy: { Component: () => import("@/domains/settings/billing/upgrade-cancel-page").then((m) => m.UpgradeCancelPage) } },
                { path: "billing/upgrade/success", lazy: { Component: () => import("@/domains/settings/billing/upgrade-success-page").then((m) => m.UpgradeSuccessPage) } },
                { path: "community", lazy: { Component: () => import("@/domains/settings/pages/community-page").then((m) => m.CommunityPage) } },
                { path: "mcp", Component: McpSettingsRedirect },
                { path: "debug", Component: DebugSettingsRedirect },
                { path: "developer", lazy: { Component: () => import("@/domains/settings/pages/developer-page").then((m) => m.DeveloperPage) } },
                { path: "advanced", lazy: { Component: () => import("@/domains/settings/pages/advanced-page").then((m) => m.AdvancedPage) } },
                { path: "danger-zone", lazy: { Component: () => import("@/domains/settings/pages/danger-zone-redirect-page").then((m) => m.DangerZoneRedirectPage) } },
                { path: "system-events", lazy: { Component: () => import("@/domains/settings/pages/system-events-redirect-page").then((m) => m.SystemEventsRedirectPage) } },
              ],
            },

            // Logs routes — full-screen overlay panel (like SettingsLayout).
            // LogsLayout reuses SidebarShell for visual consistency.
            // Lazy-loaded: analytics-only.
            {
              path: "logs",
              lazy: { Component: () => import("@/domains/logs/logs-layout").then((m) => m.LogsLayout) },
              children: [
                { index: true, lazy: { Component: () => import("@/domains/logs/pages/usage-redirect-page").then((m) => m.UsageRedirectPage) } },
                { path: "usage", lazy: { Component: () => import("@/domains/logs/pages/usage-redirect-page").then((m) => m.UsageRedirectPage) } },
                { path: "system-events", lazy: { Component: () => import("@/domains/logs/pages/system-events-page").then((m) => m.SystemEventsPage) } },
                { path: "emails", lazy: { Component: () => import("@/domains/logs/pages/emails-page").then((m) => m.EmailsPage) } },
              ],
            },
          ],
        },

        {
          Component: ChatLayout,
          children: [
            // Inner pathless wrapper: catches every error from chat-side
            // routes (home, library, identity, inspector, etc.) one layer
            // deeper than the `/assistant` boundary so the chunk-fail UI
            // variant renders *inside* ChatLayout's chrome (sidebar stays
            // visible). Non-chunk render errors are caught here too —
            // `RouteErrorBoundary` shows the full-page variant in that
            // case (`min-h-svh`), which visually takes over the route
            // content area.
            {
              ErrorBoundary: RouteErrorBoundary,
              children: [
            // ChatPage / DocumentViewerPage own their own lifecycle UI
            // (loading screens, hatching, version-selection, errors) and
            // must render in every assistant state — they are NOT placed
            // under <ActiveAssistantGate>.
            { index: true, Component: ConversationRedirect },
            { path: "conversations/:conversationId", Component: ChatPage },
            { path: "documents/:surfaceId", lazy: { Component: () => import("@/domains/chat/document-viewer-page").then((m) => m.DocumentViewerPage) } },
            // Everything below requires a resolved assistantId AND an
            // active daemon. The gate defers child rendering until the
            // lifecycle resolves so route components can rely on a
            // non-null assistantId via useActiveAssistantId().
            {
              Component: ActiveAssistantGate,
              children: [
                {
                  path: "home",
                  lazy: { Component: () => import("@/home-page-route").then((m) => m.HomePageRoute) },
                },
                // Schedules tab + per-schedule deep links. Same component as
                // `home`; HomePageRoute reads the pathname / `:scheduleId` to
                // open the Schedules tab and focus a schedule's drawer.
                {
                  path: "schedules",
                  lazy: { Component: () => import("@/home-page-route").then((m) => m.HomePageRoute) },
                },
                {
                  path: "schedules/:scheduleId",
                  lazy: { Component: () => import("@/home-page-route").then((m) => m.HomePageRoute) },
                },
                {
                  lazy: { Component: () => import("@/domains/intelligence/intelligence-layout").then((m) => m.IntelligenceLayout) },
                  children: [
                    { path: "identity", lazy: { Component: () => import("@/identity-page-route").then((m) => m.IdentityPageRoute) } },
                    { path: "personality", lazy: { Component: () => import("@/domains/intelligence/personality-page").then((m) => m.PersonalityPage) } },
                    { path: "memory", lazy: { Component: () => import("@/memory-page-route").then((m) => m.MemoryPageRoute) } },
                    { path: "plugins", lazy: { Component: () => import("@/domains/intelligence/plugins-page").then((m) => m.PluginsPage) } },
                    { path: "plugins/:name", lazy: { Component: () => import("@/domains/intelligence/plugin-detail-page").then((m) => m.PluginDetailPage) } },
                    { path: "skills", lazy: { Component: () => import("@/domains/intelligence/skills-page").then((m) => m.SkillsPage) } },
                    { path: "skills/:skillId", lazy: { Component: () => import("@/domains/intelligence/skill-detail-page").then((m) => m.SkillDetailPage) } },
                    { path: "workspace", lazy: { Component: () => import("@/domains/workspace/workspace-page").then((m) => m.WorkspacePage) } },
                    { path: "contacts", lazy: { Component: () => import("@/contacts-page-route").then((m) => m.ContactsPageRoute) } },
                    { path: "channels", lazy: { Component: () => import("@/channels-page-route").then((m) => m.ChannelsPageRoute) } },
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
              ], // end inner chunk-fail boundary (chat-side)
            },
          ],
        },

        // Catch-all within /assistant/*
        { path: "*", Component: NotFound },
          ], // end outer chunk-fail boundary (/assistant)
        },
      ],
    },

    // Top-level catch-all
    { path: "*", ErrorBoundary: RouteErrorBoundary, Component: NotFound },
];

export const router = createBrowserRouter(routeTree as never, {
  basename: getRouterBasename(),
  future: { v8_middleware: true },
});

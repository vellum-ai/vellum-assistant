import { createBrowserRouter, useNavigate } from "react-router";

import { RootLayout } from "@/components/layout/root-layout.js";
import { ChatLayout } from "@/domains/chat/chat-layout.js";
import { ChatPage } from "@/domains/chat/chat-page.js";
import { HomePage } from "@/domains/home/home-page.js";
import { LibraryPage } from "@/domains/library/library-page.js";
import { LibraryDetailPage } from "@/domains/library/library-detail-page.js";
import { NotFound } from "@/components/not-found.js";
import { SettingsTabPage } from "@/domains/settings/settings-tab-page.js";
import { AccountPage } from "@/domains/account/pages/account-page.js";
import { LoginPage } from "@/domains/account/pages/login-page.js";
import { SignupPage } from "@/domains/account/pages/signup-page.js";
import { ProviderCallbackPage } from "@/domains/account/pages/provider-callback-page.js";
import { ProviderSignupPage } from "@/domains/account/pages/provider-signup-page.js";
import { OAuthPopupCompletePage } from "@/domains/account/pages/oauth-popup-complete-page.js";
import { routes } from "@/utils/routes.js";

function HomePageRoute() {
  const navigate = useNavigate();
  return (
    <HomePage
      assistantId="default"
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
 *   │  └── OAuthPopupCompletePage (/account/oauth/popup-complete)
 *   │
 *   /assistant/* — full app with RootLayout (safe areas, viewport tracking)
 *   │  └── ChatLayout — sidebar rail, drawer, shortcuts
 *   │       ├── ChatPage (index, /assistant)
 *   │       ├── HomePageRoute (/assistant/home)
 *   │       ├── LibraryPage / LibraryDetailPage
 *   │       └── SettingsTabPage
 *
 * References:
 * - React Router data mode routing: https://reactrouter.com/start/data/routing
 * - React Router prefix routes: https://reactrouter.com/start/data/routing#prefix-route
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
    ],
  },

  // Assistant routes — full app with layout (safe areas, viewport tracking)
  {
    path: "/assistant",
    element: <RootLayout />,
    children: [
      {
        element: <ChatLayout />,
        children: [
          { index: true, element: <ChatPage /> },
          { path: "home", element: <HomePageRoute /> },
          { path: "settings/:tab", element: <SettingsTabPage /> },
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
]);

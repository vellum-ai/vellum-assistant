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
import { BASENAME } from "@/utils/routes.js";

function HomePageRoute() {
  const navigate = useNavigate();
  return (
    <HomePage
      assistantId="default"
      onStartNewChat={() => navigate("/")}
      onOpenConversation={(conversationId) =>
        navigate(`/conversations/${conversationId}`)
      }
      onSuggestionSelected={(prompt) =>
        navigate(`/?prompt=${encodeURIComponent(prompt)}`)
      }
    />
  );
}

/**
 * Route hierarchy:
 *
 *   RootLayout (pathless — safe areas, viewport tracking)
 *   ├── Account routes (no sidebar, standalone pages)
 *   │   ├── AccountPage (/account)
 *   │   ├── LoginPage (/account/login)
 *   │   ├── SignupPage (/account/signup)
 *   │   ├── ProviderCallbackPage (/account/provider/callback)
 *   │   ├── ProviderSignupPage (/account/provider/signup)
 *   │   └── OAuthPopupCompletePage (/account/oauth/popup-complete)
 *   ├── ChatLayout (path="/") — sidebar rail, drawer, shortcuts
 *   │   ├── ChatPage (index)
 *   │   ├── HomePageRoute
 *   │   ├── LibraryPage / LibraryDetailPage
 *   │   └── SettingsTabPage
 *   └── NotFound (catch-all)
 *
 * References:
 * - React Router layout routes: https://reactrouter.com/start/data/routing
 * - React Router nested routes: https://reactrouter.com/start/data/routing#nested-routes
 */
export const router = createBrowserRouter(
  [
    {
      element: <RootLayout />,
      children: [
        // Account routes — standalone pages without the chat sidebar
        { path: "account", element: <AccountPage /> },
        { path: "account/login", element: <LoginPage /> },
        { path: "account/signup", element: <SignupPage /> },
        { path: "account/provider/callback", element: <ProviderCallbackPage /> },
        { path: "account/provider/signup", element: <ProviderSignupPage /> },
        { path: "account/oauth/popup-complete", element: <OAuthPopupCompletePage /> },

        // Chat layout — sidebar rail, drawer, shortcuts
        {
          path: "/",
          element: <ChatLayout />,
          children: [
            { index: true, element: <ChatPage /> },
            { path: "home", element: <HomePageRoute /> },
            { path: "settings/:tab", element: <SettingsTabPage /> },
            { path: "library", element: <LibraryPage /> },
            { path: "library/:appId", element: <LibraryDetailPage /> },
          ],
        },

        // Catch-all
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: BASENAME },
);

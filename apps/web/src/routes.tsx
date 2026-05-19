import { createBrowserRouter, useNavigate } from "react-router";

import { RootLayout } from "@/components/layout/root-layout.js";
import { ChatLayout } from "@/domains/chat/chat-layout.js";
import { ChatPage } from "@/domains/chat/chat-page.js";
import { HomePage } from "@/domains/home/home-page.js";
import { LibraryPage } from "@/domains/library/library-page.js";
import { LibraryDetailPage } from "@/domains/library/library-detail-page.js";
import { NotFound } from "@/components/not-found.js";
import { SettingsTabPage } from "@/domains/settings/settings-tab-page.js";

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
 *   ├── ChatLayout (path="/") — sidebar rail, drawer, shortcuts
 *   │   ├── ChatPage (index)
 *   │   ├── HomePageRoute
 *   │   ├── LibraryPage / LibraryDetailPage
 *   │   └── SettingsTabPage (temporary — replaced by SettingsLayout in PR 2)
 *   └── (future: SettingsLayout as sibling to ChatLayout)
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
        {
          path: "/",
          element: <ChatLayout />,
          children: [
            { index: true, element: <ChatPage /> },
            { path: "home", element: <HomePageRoute /> },
            { path: "settings/:tab", element: <SettingsTabPage /> },
            { path: "library", element: <LibraryPage /> },
            { path: "library/:appId", element: <LibraryDetailPage /> },
            { path: "*", element: <NotFound /> },
          ],
        },
      ],
    },
  ],
  { basename: "/assistant" },
);

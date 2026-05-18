import { createBrowserRouter, useNavigate } from "react-router";
import { App } from "./App.js";
import { ChatPage } from "./domains/chat/chat-page.js";
import { HomePage } from "./domains/home/home-page.js";
import { LibraryPage } from "./domains/library/library-page.js";
import { LibraryDetailPage } from "./domains/library/library-detail-page.js";
import { NotFound } from "./components/not-found.js";
import { SettingsTabPage } from "./domains/settings/settings-tab-page.js";

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

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <App />,
      children: [
        { index: true, element: <ChatPage /> },
        {
          path: "home",
          element: <HomePageRoute />,
        },
        { path: "settings/:tab", element: <SettingsTabPage /> },
        { path: "library", element: <LibraryPage /> },
        { path: "library/:appId", element: <LibraryDetailPage /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: "/assistant" },
);

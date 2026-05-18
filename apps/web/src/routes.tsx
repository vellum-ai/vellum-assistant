import { createBrowserRouter } from "react-router";
import { App } from "./App.js";
import { ChatPage } from "./domains/chat/chat-page.js";
import { LibraryPage } from "./domains/library/library-page.js";
import { LibraryDetailPage } from "./domains/library/library-detail-page.js";
import { NotFound } from "./components/not-found.js";
import { SettingsTabPage } from "./domains/settings/settings-tab-page.js";

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <App />,
      children: [
        { index: true, element: <ChatPage /> },
        { path: "settings/:tab", element: <SettingsTabPage /> },
        { path: "library", element: <LibraryPage /> },
        { path: "library/:appId", element: <LibraryDetailPage /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: "/assistant" },
);

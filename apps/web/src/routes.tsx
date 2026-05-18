import { createBrowserRouter } from "react-router";
import { App } from "./App.js";
import { Chat } from "./pages/chat.js";
import { Library } from "./pages/library.js";
import { LibraryDetail } from "./pages/library-detail.js";
import { NotFound } from "./pages/not-found.js";
import { SettingsTab } from "./pages/settings-tab.js";

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <App />,
      children: [
        { index: true, element: <Chat /> },
        { path: "settings/:tab", element: <SettingsTab /> },
        { path: "library", element: <Library /> },
        { path: "library/:appId", element: <LibraryDetail /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: "/assistant" },
);

import { createBrowserRouter, Navigate } from 'react-router';
import { App } from './App.js';
import { ConversationNew } from './pages/conversation-new.js';
import { ConversationDetail } from './pages/conversation-detail.js';
import { Library } from './pages/library.js';
import { LibraryDetail } from './pages/library-detail.js';
import { NotFound } from './pages/not-found.js';
import { SettingsTab } from './pages/settings-tab.js';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/conversations/new" replace /> },
      { path: 'conversations/new', element: <ConversationNew /> },
      { path: 'conversations/:id', element: <ConversationDetail /> },
      { path: 'settings/:tab', element: <SettingsTab /> },
      { path: 'library', element: <Library /> },
      { path: 'library/:slug', element: <LibraryDetail /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

import { createBrowserRouter, Navigate } from 'react-router';
import { App } from './App.js';
import { ConversationNew } from './pages/ConversationNew.js';
import { ConversationDetail } from './pages/ConversationDetail.js';
import { Library } from './pages/Library.js';
import { LibraryDetail } from './pages/LibraryDetail.js';
import { NotFound } from './pages/NotFound.js';
import { SettingsTab } from './pages/SettingsTab.js';

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

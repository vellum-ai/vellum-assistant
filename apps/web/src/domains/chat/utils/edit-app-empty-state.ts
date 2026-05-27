/**
 * Empty-state overrides for the chat that opens when the user clicks "Edit"
 * on an app. The signal is purely view state — `mainView === "app-editing"`
 * with `openedAppState` set and zero messages — so no daemon contract changes
 * are required. When the user picks one of these starters, its `prompt` is
 * sent verbatim as the first user message, embedding the app reference so the
 * assistant knows what to load.
 */

import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";

export interface EditAppContext {
  name: string;
  dirName?: string;
}

export function buildEditAppGreeting(app: EditAppContext): string {
  return `Editing ${app.name} — what should we change?`;
}

function appReference(app: EditAppContext): string {
  return app.dirName ? `${app.name} (${app.dirName})` : app.name;
}

export function buildEditAppStarters(app: EditAppContext): ConversationStarter[] {
  const ref = appReference(app);
  return [
    {
      id: "edit-app:styling",
      label: "Change the styling",
      prompt: `Open ${ref} and help me change its styling.`,
      category: "edit-app",
      batch: 0,
    },
    {
      id: "edit-app:add-feature",
      label: "Add a feature",
      prompt: `Open ${ref} — I want to add a new feature.`,
      category: "edit-app",
      batch: 0,
    },
    {
      id: "edit-app:responsive",
      label: "Make it responsive",
      prompt: `Open ${ref} and make sure it works well on mobile.`,
      category: "edit-app",
      batch: 0,
    },
    {
      id: "edit-app:fix-bug",
      label: "Fix a bug",
      prompt: `Open ${ref} — there's something I want to fix.`,
      category: "edit-app",
      batch: 0,
    },
  ];
}

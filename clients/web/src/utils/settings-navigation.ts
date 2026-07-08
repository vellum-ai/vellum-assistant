/**
 * Typed sidebar model for the Settings page.
 *
 * The Settings page uses route-based navigation (e.g. /settings/general).
 * This module defines:
 *  - The canonical set of panel IDs.
 *  - A flat sidebar item list matching the macOS desktop app layout.
 */

import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Bell,
  Bookmark,
  Bug,
  Code,
  Cpu,
  CreditCard,
  Keyboard,
  KeyRound,
  Laptop,
  Mic,
  Settings,
  Users,
  Volume2,
  Puzzle,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// Panel IDs
// ---------------------------------------------------------------------------

/** All panel IDs supported by the Settings page. */
export const PANEL_IDS = [
  "integrations",
  "credentials",
  "model",
  "notifications",
  "keyboard-shortcuts",
  "sounds",
  "voice",
  "devices",
  "privacy",
  "security",
  "archive",
  "bookmarks",
  "billing",
  "community",
  "assistant-status",
  "assistant-debug",
  "advanced",
  "developer",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

// ---------------------------------------------------------------------------
// Sidebar item model
// ---------------------------------------------------------------------------

/** A single item in the flat settings sidebar. */
export interface SidebarItem {
  /** Unique panel ID. */
  id: PanelId;
  /** Human-readable label shown in the sidebar. */
  label: string;
  /** Route path used for Link-based navigation. */
  href: string;
  /** Lucide icon component rendered beside the label. */
  icon: LucideIcon;
}

/**
 * Flat sidebar items for the Settings page, matching the macOS desktop app
 * layout. Each item has a Lucide icon.
 */
export const SETTINGS_SIDEBAR: SidebarItem[] = [
  { id: "assistant-status", label: "General", href: routes.settings.general, icon: SlidersHorizontal },
  { id: "model", label: "Models & Services", href: routes.settings.ai, icon: Cpu },
  { id: "integrations", label: "Integrations", href: routes.settings.integrations, icon: Puzzle },
  { id: "credentials", label: "Credentials", href: routes.settings.credentials, icon: KeyRound },
  { id: "notifications", label: "Notifications", href: routes.settings.notifications, icon: Bell },
  { id: "keyboard-shortcuts", label: "Keyboard Shortcuts", href: routes.settings.keyboardShortcuts, icon: Keyboard },
  { id: "sounds", label: "Sounds", href: routes.settings.sounds, icon: Volume2 },
  { id: "voice", label: "Voice", href: routes.settings.voice, icon: Mic },
  { id: "devices", label: "Self-Hosted Assistants", href: routes.settings.devices, icon: Laptop },
  { id: "privacy", label: "Permissions & Privacy", href: routes.settings.privacy, icon: ShieldCheck },
  { id: "security", label: "Security", href: routes.settings.security, icon: KeyRound },
  { id: "archive", label: "Archive", href: routes.settings.archive, icon: Archive },
  { id: "bookmarks", label: "Bookmarks", href: routes.settings.bookmarks, icon: Bookmark },
  { id: "billing", label: "Billing", href: routes.settings.billing, icon: CreditCard },
  { id: "community", label: "Community", href: routes.settings.community, icon: Users },
  { id: "assistant-debug", label: "Debug", href: routes.settings.debug, icon: Bug },
  { id: "advanced", label: "Advanced", href: routes.settings.advanced, icon: Settings },
  { id: "developer", label: "Developer", href: routes.settings.developer, icon: Code },
];

const SETTINGS_TAB_ID_ALIASES: Record<string, PanelId> = {
  developer: "assistant-debug",
  debug: "assistant-debug",
  model: "model",
  privacy: "privacy",
};

function normalizeSettingsTabName(tab: string): string {
  return tab.trim().toLowerCase();
}

export function getSettingsRouteForClientTab(tab: string): string | null {
  const normalizedTab = normalizeSettingsTabName(tab);

  // Check aliases first so legacy native-client tab names (e.g. "Developer" → debug)
  // are not shadowed by newer sidebar items with the same label.
  const aliasedId = SETTINGS_TAB_ID_ALIASES[normalizedTab];
  if (aliasedId) {
    const aliasedItem = SETTINGS_SIDEBAR.find((item) => item.id === aliasedId);
    if (aliasedItem) {
      return aliasedItem.href;
    }
  }

  const matchingItem = SETTINGS_SIDEBAR.find(
    (item) =>
      normalizeSettingsTabName(item.label) === normalizedTab ||
      item.id === normalizedTab,
  );

  return matchingItem?.href ?? null;
}

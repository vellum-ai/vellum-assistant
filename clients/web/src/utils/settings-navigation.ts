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
  Bell,
  Bookmark,
  Code,
  Cpu,
  CreditCard,
  KeyRound,
  Mic,
  Settings,
  Users,
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
  "voice",
  "privacy",
  "bookmarks",
  "billing",
  "community",
  "assistant-status",
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
  { id: "voice", label: "Voice & Sounds", href: routes.settings.voice, icon: Mic },
  { id: "privacy", label: "Permissions & Privacy", href: routes.settings.privacy, icon: ShieldCheck },
  { id: "bookmarks", label: "Bookmarks", href: routes.settings.bookmarks, icon: Bookmark },
  { id: "billing", label: "Billing & Usage", href: routes.settings.billing, icon: CreditCard },
  { id: "community", label: "Community", href: routes.settings.community, icon: Users },
  { id: "advanced", label: "Advanced", href: routes.settings.advanced, icon: Settings },
  { id: "developer", label: "Developer", href: routes.settings.developer, icon: Code },
];

const SETTINGS_TAB_ID_ALIASES: Record<string, PanelId> = {
  // General, Terminal, and Doctor are in-page tabs on the Advanced page, so the
  // "developer" and "debug" client tab names resolve there.
  developer: "advanced",
  debug: "advanced",
  model: "model",
  privacy: "privacy",
  // Two-factor auth moved from the retired Security tab onto General.
  security: "assistant-status",
  // Self-hosted assistant management has no settings page; land on General.
  devices: "assistant-status",
  "self-hosted assistants": "assistant-status",
};

/**
 * Tab names that resolve to a specific view of a sidebar destination. These
 * need a query param that a sidebar item's bare `href` cannot carry, so they
 * map straight to a full route and take precedence over the panel-id aliases.
 */
const SETTINGS_TAB_ROUTE_ALIASES: Record<string, string> = {
  // Shortcut rebinding lives in the Preferences modal on General.
  "keyboard-shortcuts": `${routes.settings.general}?preferences=open`,
  "keyboard shortcuts": `${routes.settings.general}?preferences=open`,
  // Sounds is an in-page tab on the Voice & Sounds page.
  sounds: `${routes.settings.voice}?tab=sounds`,
  // Archive is an in-page tab on the Advanced page; the bare Advanced route
  // opens General, so the archive alias carries the ?tab= param.
  archive: `${routes.settings.advanced}?tab=archive`,
};

function normalizeSettingsTabName(tab: string): string {
  return tab.trim().toLowerCase();
}

export function getSettingsRouteForClientTab(tab: string): string | null {
  const normalizedTab = normalizeSettingsTabName(tab);

  // Check aliases first so legacy native-client tab names (e.g. "Developer" → debug)
  // are not shadowed by newer sidebar items with the same label.
  const aliasedRoute = SETTINGS_TAB_ROUTE_ALIASES[normalizedTab];
  if (aliasedRoute) {
    return aliasedRoute;
  }

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

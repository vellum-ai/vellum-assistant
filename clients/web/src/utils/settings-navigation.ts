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
  BarChart3,
  Bell,
  Bookmark,
  Bug,
  Code,
  Cpu,
  KeyRound,
  Mic,
  Users,
  Puzzle,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
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
  "sounds",
  "privacy",
  "bookmarks",
  "billing",
  "community",
  "assistant-status",
  "debug",
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
  { id: "voice", label: "Voice", href: routes.settings.voice, icon: Mic },
  { id: "sounds", label: "Sounds", href: routes.settings.sounds, icon: Volume2 },
  { id: "privacy", label: "Permissions & Privacy", href: routes.settings.privacy, icon: ShieldCheck },
  { id: "bookmarks", label: "Bookmarks", href: routes.settings.bookmarks, icon: Bookmark },
  { id: "billing", label: "Usage", href: routes.settings.usage, icon: BarChart3 },
  { id: "community", label: "Community", href: routes.settings.community, icon: Users },
  { id: "debug", label: "Debug", href: routes.settings.debug, icon: Bug },
  { id: "developer", label: "Developer", href: routes.settings.developer, icon: Code },
];

const SETTINGS_TAB_ID_ALIASES: Record<string, PanelId> = {
  // General, Terminal, and Doctor are in-page tabs on the Debug page, so the
  // "developer" and legacy "advanced" client tab names resolve there.
  developer: "debug",
  advanced: "debug",
  model: "model",
  privacy: "privacy",
  // Two-factor auth moved from the retired Security tab onto General.
  security: "assistant-status",
  // The Voice page dropped its Sounds tab (Sounds is its own page now), so the
  // old combined label has to keep resolving.
  "voice & sounds": "voice",
  "voice and sounds": "voice",
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
  // Speech services (Text-to-Speech / Speech-to-Text) are BYO provider config,
  // so they live with every other provider on Models & Services.
  services: routes.settings.ai,
  "text-to-speech": routes.settings.ai,
  "speech-to-text": routes.settings.ai,
  // Archive is an in-page tab on the Debug page; the bare Debug route opens
  // General, so the archive alias carries the ?tab= param.
  archive: `${routes.settings.debug}?tab=archive`,
  // The Billing & Usage page moved to `/assistant/settings/usage`, which has
  // both a Billing and a Usage in-page tab (Billing is the default for a
  // signed-in viewer). Route each client-tab lookup straight to its sub-tab so
  // model- and native-driven navigation lands on the requested tab regardless
  // of the page default. The sidebar item's own bare href is left untouched, so
  // clicking the nav entry still opens the default tab.
  billing: routes.settings.usageBilling,
  "billing & usage": routes.settings.usageBilling,
  usage: `${routes.settings.usage}?tab=usage`,
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

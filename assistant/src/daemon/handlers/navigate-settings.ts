import type { HandlerContext } from './shared.js';

/**
 * Valid settings tab identifiers matching the macOS client's SettingsTab enum.
 * These correspond to the raw values the Swift client expects.
 */
export const SETTINGS_TABS = [
  'Connect',
  'Integrations',
  'Trust',
  'Schedules',
  'Heartbeat',
  'Wake Word',
  'Appearance',
  'Advanced',
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number];

/**
 * Broadcast a `navigate_settings` message to all connected clients,
 * opening the settings panel to the specified tab.
 */
export function navigateToSettingsTab(ctx: HandlerContext, tab: SettingsTabId): void {
  ctx.broadcast({ type: 'navigate_settings', tab });
}

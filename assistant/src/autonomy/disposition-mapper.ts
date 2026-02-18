/**
 * Disposition mapper — bridges autonomy tiers to watcher event dispositions.
 *
 * The watcher engine uses three dispositions for event handling:
 *   - `silent`   — act without notifying the user
 *   - `notify`   — alert the user (with optional draft attached)
 *   - `escalate` — alert the user and take no autonomous action
 *
 * This module maps autonomy tiers to those dispositions:
 *   - `auto`   → `silent`   (act without notifying)
 *   - `draft`  → `notify`   (prepare draft, alert user for approval)
 *   - `notify` → `escalate` (alert user, take no action)
 */

import type { AutonomyTier } from './types.js';

/** Watcher event disposition strings used by the watcher engine. */
export type WatcherDisposition = 'silent' | 'notify' | 'escalate';

const TIER_TO_DISPOSITION: Record<AutonomyTier, WatcherDisposition> = {
  auto: 'silent',
  draft: 'notify',
  notify: 'escalate',
};

/**
 * Map an autonomy tier to the corresponding watcher disposition.
 */
export function mapTierToDisposition(tier: AutonomyTier): WatcherDisposition {
  return TIER_TO_DISPOSITION[tier];
}

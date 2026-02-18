/**
 * Autonomy tier types — govern what runs unsupervised per channel/category/contact.
 *
 * Three tiers:
 * - `auto`   — act silently, no human in the loop
 * - `draft`  — prepare a draft for human approval before sending
 * - `notify` — alert the user but take no action (most conservative)
 */

export type AutonomyTier = 'auto' | 'draft' | 'notify';

export const AUTONOMY_TIERS: readonly AutonomyTier[] = ['auto', 'draft', 'notify'] as const;

/**
 * Policy configuration for autonomy tiers. This is persisted as JSON config,
 * not in the SQLite database — it represents explicit policy decisions, not
 * learned preferences.
 */
export interface AutonomyConfig {
  /** Global fallback tier when no more-specific rule matches. Defaults to 'notify'. */
  defaultTier: AutonomyTier;

  /** Per-channel defaults (e.g., { email: 'draft', slack: 'auto' }). */
  channelDefaults: Record<string, AutonomyTier>;

  /** Per-category overrides keyed by triage category (e.g., { newsletter: 'auto' }). */
  categoryOverrides: Record<string, AutonomyTier>;

  /** Per-contact overrides keyed by contact ID. */
  contactOverrides: Record<string, AutonomyTier>;
}

/** Sensible defaults — conservative: everything starts as notify-only. */
export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  defaultTier: 'notify',
  channelDefaults: {},
  categoryOverrides: {},
  contactOverrides: {},
};

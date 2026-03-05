/**
 * Autonomy resolver — determines the effective autonomy tier for an
 * inbound message based on its triage result, channel, and contact.
 *
 * Resolution order (first match wins):
 *   1. Matched playbook with an explicit autonomy level
 *   2. Contact-specific override
 *   3. Category override for the triage result's category
 *   4. Channel default
 *   5. Global default tier (falls back to 'notify')
 */

import { getAutonomyConfig } from "./autonomy-store.js";
import type { AutonomyTier } from "./types.js";

/** Local stand-in — the canonical TriageResult was removed with the triage engine. */
interface TriageResult {
  category: string;
  confidence: number;
  suggestedAction: string;
  matchedPlaybooks: Array<{
    trigger: string;
    action: string;
    autonomyLevel: string;
  }>;
}
import { AUTONOMY_TIERS } from "./types.js";

/**
 * Resolve the autonomy tier for a triaged message.
 *
 * @param triageResult - Output from the triage engine
 * @param channel      - The channel the message arrived on (e.g. 'email', 'slack')
 * @param contactId    - Optional contact ID for contact-specific overrides
 */
export function resolveAutonomyTier(
  triageResult: TriageResult,
  channel: string,
  contactId?: string,
): AutonomyTier {
  // 1. Playbook-specified autonomy level (first matched playbook wins)
  for (const playbook of triageResult.matchedPlaybooks) {
    if (isValidTier(playbook.autonomyLevel)) {
      return playbook.autonomyLevel as AutonomyTier;
    }
  }

  const config = getAutonomyConfig();

  // 2. Contact-specific override
  if (contactId && Object.hasOwn(config.contactOverrides, contactId)) {
    return config.contactOverrides[contactId];
  }

  // 3. Category override
  if (Object.hasOwn(config.categoryOverrides, triageResult.category)) {
    return config.categoryOverrides[triageResult.category];
  }

  // 4. Channel default
  if (Object.hasOwn(config.channelDefaults, channel)) {
    return config.channelDefaults[channel];
  }

  // 5. Global default
  return config.defaultTier;
}

function isValidTier(value: unknown): value is AutonomyTier {
  return (
    typeof value === "string" && AUTONOMY_TIERS.includes(value as AutonomyTier)
  );
}

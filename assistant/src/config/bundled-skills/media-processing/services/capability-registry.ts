/**
 * Generic capability registry with tier-based classification.
 *
 * The registry is domain-agnostic: any domain (sports, surveillance, lecture
 * recording, etc.) can register its own capabilities. Basketball-specific
 * capabilities are registered as one example via `registerDefaults()`.
 */

import type { CapabilityTier } from '../../../../memory/media-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Capability {
  /** Unique name used as the key in tracking profiles (e.g. 'turnovers'). */
  name: string;
  /** Human-readable description of what this capability detects/tracks. */
  description: string;
  /** Maturity tier governing confidence disclaimers and default inclusion. */
  tier: CapabilityTier;
  /** Domain this capability belongs to (e.g. 'basketball', 'surveillance'). */
  domain: string;
  /** Granularity level (e.g. 'team', 'per-player'). */
  granularity?: string;
}

// ---------------------------------------------------------------------------
// Registry (singleton in-memory Map)
// ---------------------------------------------------------------------------

const registry = new Map<string, Capability>();

/**
 * Register a capability. Overwrites any existing capability with the same name.
 */
export function registerCapability(cap: Capability): void {
  registry.set(cap.name, cap);
}

/**
 * Get all registered capabilities, optionally filtered by domain.
 */
export function getCapabilities(domain?: string): Capability[] {
  const all = Array.from(registry.values());
  if (!domain) return all;
  return all.filter((c) => c.domain === domain);
}

/**
 * Get capabilities filtered by tier.
 */
export function getCapabilitiesByTier(tier: CapabilityTier): Capability[] {
  return Array.from(registry.values()).filter((c) => c.tier === tier);
}

/**
 * Look up a single capability by name.
 */
export function getCapabilityByName(name: string): Capability | undefined {
  return registry.get(name);
}

/**
 * Get all unique domain names in the registry.
 */
export function getRegisteredDomains(): string[] {
  const domains = new Set<string>();
  for (const cap of registry.values()) {
    domains.add(cap.domain);
  }
  return Array.from(domains);
}

// ---------------------------------------------------------------------------
// Default registrations — basketball as one example domain
// ---------------------------------------------------------------------------

/**
 * Register the default basketball capabilities as an example domain.
 * Other domains should call `registerCapability()` with their own entries.
 */
export function registerDefaults(): void {
  // Ready tier: production-quality detection
  registerCapability({
    name: 'turnovers',
    description: 'Team-level turnover detection',
    tier: 'ready',
    domain: 'basketball',
    granularity: 'team',
  });

  // Beta tier: functional but may have accuracy gaps
  registerCapability({
    name: 'field_goals',
    description: 'Team-level field goal detection',
    tier: 'beta',
    domain: 'basketball',
    granularity: 'team',
  });

  registerCapability({
    name: 'rebounds',
    description: 'Team-level rebound detection',
    tier: 'beta',
    domain: 'basketball',
    granularity: 'team',
  });

  registerCapability({
    name: 'turnovers_per_player',
    description: 'Per-player turnover attribution',
    tier: 'beta',
    domain: 'basketball',
    granularity: 'per-player',
  });

  // Experimental tier: early-stage, expect noise
  registerCapability({
    name: 'field_goals_per_player',
    description: 'Per-player field goal attribution',
    tier: 'experimental',
    domain: 'basketball',
    granularity: 'per-player',
  });

  registerCapability({
    name: 'rebounds_per_player',
    description: 'Per-player rebound attribution',
    tier: 'experimental',
    domain: 'basketball',
    granularity: 'per-player',
  });
}

// Auto-register defaults on first import
registerDefaults();

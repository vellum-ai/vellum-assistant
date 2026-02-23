/**
 * Select and persist a tracking profile for a media asset.
 *
 * When called without capabilities, returns the available capabilities
 * organized by tier so the user can choose. When called with capabilities,
 * validates them against the registry and stores the profile.
 */

import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { getMediaAssetById, setTrackingProfile, getTrackingProfile, type CapabilityProfile } from '../../../../memory/media-store.js';
import {
  getCapabilities,
  getCapabilityByName,
  getRegisteredDomains,
  type Capability,
} from '../services/capability-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByTier(caps: Capability[]): Record<string, Capability[]> {
  const groups: Record<string, Capability[]> = { ready: [], beta: [], experimental: [] };
  for (const cap of caps) {
    if (!groups[cap.tier]) groups[cap.tier] = [];
    groups[cap.tier].push(cap);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required.', isError: true };
  }

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `No media asset found with id "${assetId}".`, isError: true };
  }

  const requestedCapabilities = input.capabilities as string[] | undefined;

  // If no capabilities provided, return available options for the user to choose
  if (!requestedCapabilities || requestedCapabilities.length === 0) {
    const allCaps = getCapabilities();
    const domains = getRegisteredDomains();
    const byTier = groupByTier(allCaps);

    const currentProfile = getTrackingProfile(assetId);

    return {
      content: JSON.stringify({
        message: 'No capabilities specified. Here are the available capabilities organized by tier. Call again with a capabilities array to enable specific ones.',
        domains,
        availableCapabilities: {
          ready: byTier.ready.map((c) => ({
            name: c.name,
            description: c.description,
            domain: c.domain,
            granularity: c.granularity ?? null,
          })),
          beta: byTier.beta.map((c) => ({
            name: c.name,
            description: c.description,
            domain: c.domain,
            granularity: c.granularity ?? null,
            note: 'Beta: functional but may have accuracy gaps',
          })),
          experimental: byTier.experimental.map((c) => ({
            name: c.name,
            description: c.description,
            domain: c.domain,
            granularity: c.granularity ?? null,
            note: 'Experimental: early-stage, expect noise in results',
          })),
        },
        currentProfile: currentProfile ? currentProfile.capabilities : null,
      }, null, 2),
      isError: false,
    };
  }

  // Validate requested capabilities exist in the registry
  const capabilities: CapabilityProfile = {};
  const unknownCaps: string[] = [];

  for (const capName of requestedCapabilities) {
    const registered = getCapabilityByName(capName);
    if (!registered) {
      unknownCaps.push(capName);
      continue;
    }
    capabilities[capName] = { enabled: true, tier: registered.tier };
  }

  if (unknownCaps.length > 0) {
    const allCaps = getCapabilities();
    return {
      content: JSON.stringify({
        error: `Unknown capabilities: ${unknownCaps.join(', ')}`,
        availableCapabilities: allCaps.map((c) => c.name),
      }, null, 2),
      isError: true,
    };
  }

  // Store the profile
  const profile = setTrackingProfile(assetId, capabilities);

  // Build response with tier labels
  const profileSummary: Record<string, { enabled: boolean; tier: string; tierLabel: string }> = {};
  for (const [name, entry] of Object.entries(profile.capabilities)) {
    const tierLabels: Record<string, string> = {
      ready: '[Ready]',
      beta: '[Beta]',
      experimental: '[Experimental]',
    };
    profileSummary[name] = {
      enabled: entry.enabled,
      tier: entry.tier,
      tierLabel: tierLabels[entry.tier] ?? `[${entry.tier}]`,
    };
  }

  return {
    content: JSON.stringify({
      message: 'Tracking profile saved.',
      assetId: profile.assetId,
      profileId: profile.id,
      capabilities: profileSummary,
    }, null, 2),
    isError: false,
  };
}

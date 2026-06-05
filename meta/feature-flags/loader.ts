/**
 * Unified feature flag registry loader.
 *
 * Reads the canonical `feature-flag-registry.json` and provides typed access
 * to the full registry as well as scope-filtered subsets.
 *
 * This loader is intended for use by both the assistant and gateway packages.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureFlagScope = 'assistant' | 'client' | 'both';

export type FeatureFlagValue = boolean | string;

export interface FeatureFlagDefinition {
  id: string;
  scope: FeatureFlagScope;
  key: string;
  label: string;
  description: string;
  defaultEnabled: FeatureFlagValue;
}

export interface FeatureFlagRegistry {
  version: number;
  flags: FeatureFlagDefinition[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and parse the unified feature flag registry from disk.
 *
 * Resolves the JSON path relative to *this* file so the loader works
 * regardless of the caller's working directory.
 */
export async function loadFeatureFlagRegistry(): Promise<FeatureFlagRegistry> {
  const registryPath = join(import.meta.dirname ?? __dirname, 'feature-flag-registry.json');
  const raw = await readFile(registryPath, 'utf-8');
  return JSON.parse(raw) as FeatureFlagRegistry;
}

// ---------------------------------------------------------------------------
// Scope filters
// ---------------------------------------------------------------------------

/** Return flags consumed by the assistant backend (`scope === 'assistant'` or `'both'`). */
export function getAssistantScopeFlags(registry: FeatureFlagRegistry): FeatureFlagDefinition[] {
  return registry.flags.filter((f) => f.scope === 'assistant' || f.scope === 'both');
}

/** Return flags consumed by clients (`scope === 'client'` or `'both'`). */
export function getClientScopeFlags(registry: FeatureFlagRegistry): FeatureFlagDefinition[] {
  return registry.flags.filter((f) => f.scope === 'client' || f.scope === 'both');
}

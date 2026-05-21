import registry from "./feature-flag-registry.json";

export type FlagScope = "client" | "assistant";

export interface FlagDefinition {
  id: string;
  scope: FlagScope;
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

const flags = registry.flags as FlagDefinition[];

function normalizeKey(kebabKey: string): string {
  return kebabKey.replace(/-/g, "").toLowerCase();
}

function buildScopeDefaults(scope: FlagScope): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};
  for (const flag of flags) {
    if (flag.scope === scope) {
      defaults[normalizeKey(flag.key)] = flag.defaultEnabled;
    }
  }
  return defaults;
}

function buildNormalizedLookup(
  scope: FlagScope,
): Record<string, FlagDefinition> {
  const lookup: Record<string, FlagDefinition> = {};
  for (const flag of flags) {
    if (flag.scope === scope) {
      lookup[normalizeKey(flag.key)] = flag;
    }
  }
  return lookup;
}

export const CLIENT_FLAG_DEFAULTS = buildScopeDefaults("client");
export const ASSISTANT_FLAG_DEFAULTS = buildScopeDefaults("assistant");

export const CLIENT_FLAG_LOOKUP = buildNormalizedLookup("client");
export const ASSISTANT_FLAG_LOOKUP = buildNormalizedLookup("assistant");

export type ClientFeatureFlags = Record<string, boolean>;
export type AssistantFeatureFlags = Record<string, boolean>;

export function ldKeyToNormalized(ldKey: string): string {
  return normalizeKey(ldKey);
}

export { flags as ALL_FLAGS };

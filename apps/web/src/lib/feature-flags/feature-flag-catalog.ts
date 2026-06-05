import registry from "./feature-flag-registry.json" with { type: "json" };

export type FlagScope = "client" | "assistant" | "both";
export type SingleScope = Exclude<FlagScope, "both">;

export function scopeIncludes(
  scope: FlagScope,
  target: SingleScope,
): boolean {
  return scope === target || scope === "both";
}

export interface FlagDefinition {
  id: string;
  scope: FlagScope;
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean | string;
}

const flags = registry.flags as FlagDefinition[];

const STORE_KEY_OVERRIDES: Record<string, string> = {
  "openai-compatible-endpoints": "openAICompatibleEndpoints",
};

function kebabToStoreKey(kebabKey: string): string {
  const override = STORE_KEY_OVERRIDES[kebabKey];
  if (override) return override;
  const parts = kebabKey.split("-");
  return parts
    .map((part, i) => {
      if (part === "ui") return "UI";
      if (i === 0) return part;
      return part[0].toUpperCase() + part.slice(1);
    })
    .join("");
}

function buildScopeDefaults(scope: SingleScope): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};
  for (const flag of flags) {
    if (typeof flag.defaultEnabled !== "boolean") continue;
    if (scopeIncludes(flag.scope, scope)) {
      defaults[kebabToStoreKey(flag.key)] = flag.defaultEnabled;
    }
  }
  return defaults;
}

export const CLIENT_FLAG_DEFAULTS = buildScopeDefaults("client");
export const ASSISTANT_FLAG_DEFAULTS = buildScopeDefaults("assistant");

export type ClientFeatureFlags = Record<string, boolean>;
export type AssistantFeatureFlags = Record<string, boolean>;

const STORE_KEY_TO_FLAG = new Map<string, FlagDefinition>();
for (const flag of flags) {
  STORE_KEY_TO_FLAG.set(kebabToStoreKey(flag.key), flag);
}

const STORE_KEY_TO_FLAG_KEY = new Map<string, string>();
for (const flag of flags) {
  STORE_KEY_TO_FLAG_KEY.set(kebabToStoreKey(flag.key), flag.key);
}

export function flagKeyToStoreKey(flagKey: string): string {
  return kebabToStoreKey(flagKey);
}

export function storeKeyToFlagKey(storeKey: string): string | undefined {
  return STORE_KEY_TO_FLAG_KEY.get(storeKey);
}

export function getFlagDefinition(storeKey: string): FlagDefinition | undefined {
  return STORE_KEY_TO_FLAG.get(storeKey);
}

export { flags as ALL_FLAGS };

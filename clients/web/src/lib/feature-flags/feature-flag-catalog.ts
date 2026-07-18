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
  values?: string[];
}

const flags = registry.flags as FlagDefinition[];

const STORE_KEY_OVERRIDES: Record<string, string> = {};

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

function buildStringScopeDefaults(scope: SingleScope): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const flag of flags) {
    if (typeof flag.defaultEnabled !== "string") continue;
    if (scopeIncludes(flag.scope, scope)) {
      defaults[kebabToStoreKey(flag.key)] = flag.defaultEnabled;
    }
  }
  return defaults;
}

export const CLIENT_FLAG_DEFAULTS = buildScopeDefaults("client");
export const ASSISTANT_FLAG_DEFAULTS = buildScopeDefaults("assistant");
export const CLIENT_STRING_FLAG_DEFAULTS = buildStringScopeDefaults("client");
export const ASSISTANT_STRING_FLAG_DEFAULTS = buildStringScopeDefaults("assistant");

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

// -- Env flag override helpers ------------------------------------------------

const VITE_FLAG_PREFIX = "VITE_VELLUM_FLAG_";

function upperSnakeToKebab(upper: string): string {
  return upper.toLowerCase().replace(/_/g, "-");
}

const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off"]);

const FLAG_KEY_TO_DEF = new Map<string, FlagDefinition>();
for (const flag of flags) {
  FLAG_KEY_TO_DEF.set(flag.key, flag);
}

function isStringFlag(def: FlagDefinition | undefined): boolean {
  return typeof def?.defaultEnabled === "string";
}

function parseEnvValue(
  flagKey: string,
  raw: string,
): boolean | string | undefined {
  const def = FLAG_KEY_TO_DEF.get(flagKey);
  const lower = raw.toLowerCase();
  // Arms like "on"/"off" are variant names, not booleans — match declared
  // arms case-insensitively; a value matching no arm is dropped as invalid.
  if (isStringFlag(def)) {
    if (!def?.values) {
      return raw;
    }
    return def.values.find((arm) => arm.toLowerCase() === lower);
  }
  if (TRUTHY.has(lower)) {
    return true;
  }
  if (FALSY.has(lower)) {
    return false;
  }
  return raw;
}

function computeEnvFlagOverrides(): Record<string, boolean | string> {
  if (
    typeof window !== "undefined" &&
    window.__VELLUM_FLAG_OVERRIDES__ != null
  ) {
    return { ...window.__VELLUM_FLAG_OVERRIDES__ };
  }

  const overrides: Record<string, boolean | string> = {};
  const env = import.meta.env;
  for (const key of Object.keys(env)) {
    if (key.startsWith(VITE_FLAG_PREFIX)) {
      const flagKey = upperSnakeToKebab(key.slice(VITE_FLAG_PREFIX.length));
      const raw = env[key as keyof ImportMetaEnv];
      if (raw != null) {
        const value = parseEnvValue(flagKey, raw);
        if (value !== undefined) {
          overrides[flagKey] = value;
        }
      }
    }
  }
  return overrides;
}

let cachedOverrides: Record<string, boolean | string> | null = null;

export function readEnvFlagOverrides(): Record<string, boolean | string> {
  if (cachedOverrides === null) {
    cachedOverrides = computeEnvFlagOverrides();
  }
  return cachedOverrides;
}

export function resetEnvOverridesCache(): void {
  cachedOverrides = null;
}

export function getEnvFlagOverridesForScope(
  scope: SingleScope,
): { bool: Record<string, boolean>; str: Record<string, string> } {
  const overrides = readEnvFlagOverrides();
  const bool: Record<string, boolean> = {};
  const str: Record<string, string> = {};

  for (const [key, value] of Object.entries(overrides)) {
    const def = FLAG_KEY_TO_DEF.get(key);
    if (!def || !scopeIncludes(def.scope, scope)) {
      continue;
    }

    const storeKey = flagKeyToStoreKey(key);
    if (isStringFlag(def)) {
      // Injectors (Electron preload, CLI) boolean-coerce booleanish values
      // before the registry type is known; map back to the matching arm.
      const arm = typeof value === "string" ? value : value ? "on" : "off";
      if (typeof value === "string" || def.values?.includes(arm)) {
        str[storeKey] = arm;
      }
    } else if (typeof value === "boolean") {
      bool[storeKey] = value;
    } else {
      str[storeKey] = value;
    }
  }

  return { bool, str };
}

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { toKebabCase } from "@/domains/settings/ai/slugify";

/**
 * Convert an arbitrary label into a URL/key-safe slug: lowercase, collapse any
 * run of non-alphanumeric characters into a single `-`, and strip leading and
 * trailing separators. e.g. "Claude Opus 4.7" -> "claude-opus-4-7".
 */
function slugify(input: string): string {
  return toKebabCase(input);
}

/**
 * Return `base` if it does not already exist in `existing`, otherwise append a
 * numeric suffix (`-2`, `-3`, ...) until the result is unique. Comparison is
 * case-insensitive.
 */
function dedupeKey(base: string, existing: string[]): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) {
    return base;
  }
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (taken.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

/**
 * Derive default display name and key for a new provider connection of the
 * given provider type, ensuring the key does not collide with existing
 * connection names.
 */
export function deriveProviderDefaults(
  providerType: string,
  existingConnectionNames: string[],
): { name: string; key: string } {
  return {
    name: PROVIDER_DISPLAY_NAMES[providerType] ?? providerType,
    key: dedupeKey(slugify(providerType), existingConnectionNames),
  };
}

/**
 * Derive default name and key for a new profile from a model's display name,
 * ensuring the key does not collide with existing profile names.
 */
export function deriveProfileDefaults(
  modelDisplayName: string,
  existingProfileNames: string[],
): { name: string; key: string } {
  return {
    name: modelDisplayName,
    key: dedupeKey(slugify(modelDisplayName), existingProfileNames),
  };
}

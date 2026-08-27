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
 * connection names. The key follows the daemon's `${provider}-personal`
 * convention (see `resolveDefaultConnectionName`) so that recreating a
 * provider satisfies dangling default-provider/profile bindings that
 * reference the conventional row. Provider keys are not user-editable, so the
 * seed must match the convention and remain unique on its own.
 */
export function deriveProviderDefaults(
  providerType: string,
  existingConnectionNames: string[],
): { name: string; key: string } {
  return {
    name: PROVIDER_DISPLAY_NAMES[providerType] ?? providerType,
    key: dedupeKey(
      `${slugify(providerType)}-personal`,
      existingConnectionNames,
    ),
  };
}

/**
 * Make a profile name unique. Returns `base` when it is free, otherwise the
 * same name with a numeric suffix appended: "Claude Opus 4.8 (2)", "(3)", and
 * so on.
 *
 * A profile is stored under a key derived from its name, so a candidate is
 * rejected when either the name itself or the key it slugifies to is already
 * taken. Two different names can slugify to the same key ("Fast & Cheap" and
 * "fast cheap" both give `fast-cheap`), which is why both are checked.
 * Comparison is case-insensitive.
 *
 * The suffix is the LOWEST free number, not one past the highest, so a
 * sequence with a hole fills the hole: with "(2)" and "(4)" taken, the next
 * name is "(3)". Numbering by "how many copies exist" would make the suffix
 * depend on history, so deleting an early copy would shift what the next one
 * is called; the lowest free number only depends on what is there now.
 *
 * `ownKey` is the key of the profile being edited. It is held out of the taken
 * set so re-deriving a name for an existing profile does not collide with the
 * profile itself.
 */
export function uniqueProfileName(
  base: string,
  existingProfileKeys: string[],
  ownKey?: string,
): string {
  const taken = new Set(
    existingProfileKeys
      .filter((key) => key !== ownKey)
      .map((key) => key.toLowerCase()),
  );
  const isFree = (candidate: string) =>
    !taken.has(candidate.toLowerCase()) &&
    !taken.has(slugify(candidate).toLowerCase());

  if (isFree(base)) {
    return base;
  }
  let suffix = 2;
  while (!isFree(`${base} (${suffix})`)) {
    suffix += 1;
  }
  return `${base} (${suffix})`;
}

/**
 * Derive the display name and key a new profile opens with, from the display
 * name of the model the user just picked. The key is never shown or edited:
 * it is always the slug of the name, so making the name unique
 * ({@link uniqueProfileName}) is what makes the key unique too.
 */
export function deriveProfileDefaults(
  modelDisplayName: string,
  existingProfileKeys: string[],
  ownKey?: string,
): { name: string; key: string } {
  const name = uniqueProfileName(modelDisplayName, existingProfileKeys, ownKey);
  return { name, key: slugify(name) };
}

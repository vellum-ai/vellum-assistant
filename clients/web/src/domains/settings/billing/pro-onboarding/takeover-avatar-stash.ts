import type { QueryClient } from "@tanstack/react-query";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { isCharacterTraits } from "@/types/avatar";

/**
 * The render inputs of the active assistant's avatar, captured at the moment a
 * Stripe checkout redirect fires, so the post-checkout takeover can draw the
 * avatar immediately on a cold return instead of holding an empty stage for
 * the 2–3s the live avatar query takes to resolve.
 *
 * Stored in sessionStorage (per-tab, survives the Stripe redirect round-trip,
 * dies with the tab) under a 30-minute TTL: a checkout abandoned longer than
 * that shouldn't resurface as a phantom avatar.
 */
export interface TakeoverAvatarStash {
  assistantId: string;
  components: CharacterComponents;
  /**
   * Null for a `kind: "none"` avatar, which draws the bundled-fallback
   * creature — so stashing null mirrors the eventual live render.
   */
  traits: CharacterTraits | null;
  savedAt: number;
}

const STORAGE_KEY = "vellum.pro-takeover-avatar";
const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * In-memory mirror of the stash, so an unavailable sessionStorage (private
 * mode, quota, storage disabled) can't silently drop it.
 */
let inMemoryStash: TakeoverAvatarStash | null = null;

export function saveTakeoverAvatarStash(
  stash: Omit<TakeoverAvatarStash, "savedAt">,
): void {
  const stamped: TakeoverAvatarStash = { ...stash, savedAt: Date.now() };
  // Always keep the memory copy so a throwing sessionStorage can't lose it.
  inMemoryStash = stamped;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
  } catch {
    // sessionStorage may be unavailable (private mode, quota). The in-memory
    // mirror above preserves the stash — never block the checkout redirect.
  }
}

/**
 * The stashed avatar, or `null` when absent, unparsable, malformed, or older
 * than the TTL — anything unusable is cleared so it can't resurface. Falls
 * back to the in-memory mirror when sessionStorage is unreachable or empty.
 */
export function readTakeoverAvatarStash(): TakeoverAvatarStash | null {
  let raw: string | null = null;
  if (typeof sessionStorage !== "undefined") {
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      // sessionStorage unreachable — fall back to the in-memory mirror.
      return readInMemoryStash();
    }
  }
  if (!raw) {
    return readInMemoryStash();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearTakeoverAvatarStash();
    return null;
  }
  if (
    !isTakeoverAvatarStash(parsed) ||
    Date.now() - parsed.savedAt > MAX_AGE_MS
  ) {
    clearTakeoverAvatarStash();
    return null;
  }
  return parsed;
}

export function clearTakeoverAvatarStash(): void {
  inMemoryStash = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // see saveTakeoverAvatarStash
  }
}

/**
 * Capture the active assistant's cached avatar into the stash, or clear the
 * stash when there is nothing drawable to capture.
 *
 * Every Stripe redirect site calls this, and every call either writes a fresh
 * stash or removes a stale one — so a previous user's (or a previous avatar's)
 * stash can never ride along with a new checkout.
 */
export function captureTakeoverAvatarStash(queryClient: QueryClient): void {
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  if (!assistantId) {
    clearTakeoverAvatarStash();
    return;
  }

  // Prefix match: the live query key appends a `supportsManifest` boolean, so
  // this finds the entry whichever variant is cached.
  const entries = queryClient.getQueriesData<{
    components: CharacterComponents | null;
    traits: CharacterTraits | null;
    customImageUrl: string | null;
  }>({ queryKey: avatarQueryKey(assistantId) });
  const data = entries.find(([, value]) => value !== undefined)?.[1];

  // A custom image is a blob URL, dead after the reload — the takeover's
  // placeholder covers those users instead.
  if (!data || data.customImageUrl != null || data.components == null) {
    clearTakeoverAvatarStash();
    return;
  }

  saveTakeoverAvatarStash({
    assistantId,
    components: data.components,
    traits: data.traits,
  });
}

/**
 * The in-memory mirror, applying the same TTL as the sessionStorage read so an
 * abandoned stash can't resurface. Self-clears an expired mirror.
 */
function readInMemoryStash(): TakeoverAvatarStash | null {
  if (!inMemoryStash) {
    return null;
  }
  if (Date.now() - inMemoryStash.savedAt > MAX_AGE_MS) {
    inMemoryStash = null;
    return null;
  }
  return inMemoryStash;
}

/**
 * Shape check only — `ChatAvatar` is defensive about component contents, so
 * this rejects garbage rather than deep-guarding the whole component tree.
 */
function isTakeoverAvatarStash(value: unknown): value is TakeoverAvatarStash {
  if (typeof value !== "object" || value === null) return false;
  const stash = value as Record<string, unknown>;
  if (typeof stash.assistantId !== "string") return false;
  if (typeof stash.savedAt !== "number") return false;
  if (stash.traits !== null && !isCharacterTraits(stash.traits)) return false;
  const components = stash.components;
  if (typeof components !== "object" || components === null) return false;
  const parts = components as Record<string, unknown>;
  return (
    Array.isArray(parts.bodyShapes) &&
    Array.isArray(parts.eyeStyles) &&
    Array.isArray(parts.colors)
  );
}

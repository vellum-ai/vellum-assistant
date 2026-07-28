import type { QueryClient } from "@tanstack/react-query";

import { avatarQueryKey, type AvatarData } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  isCharacterTraits,
  type CharacterComponents,
  type CharacterTraits,
} from "@/types/avatar";

/**
 * The render inputs of the active assistant's avatar, captured at the moment a
 * Stripe checkout redirect fires, so the post-checkout takeover can draw the
 * avatar immediately on a cold return instead of holding an empty stage for
 * the 2-3s the live avatar query takes to resolve.
 *
 * Stored in sessionStorage (per-tab, survives the Stripe redirect round-trip,
 * dies with the tab) under a 30-minute TTL: a checkout abandoned longer than
 * that shouldn't resurface as a phantom avatar.
 *
 * Only ever the snapshot of an org positively known to hold one assistant,
 * since {@link captureTakeoverAvatarStash} skips every other case. That is what
 * lets the takeover draw it before the target assistant resolves: with one
 * creature in the org there is no other one it could be aiming at.
 */
export interface TakeoverAvatarStash {
  assistantId: string;
  components: CharacterComponents;
  /**
   * Null for a `kind: "none"` avatar, which draws the bundled-fallback
   * creature, so stashing null mirrors the eventual live render.
   */
  traits: CharacterTraits | null;
  savedAt: number;
}

const STORAGE_KEY = "vellum.pro-takeover-avatar";
const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * In-memory mirror of the stash, which covers the native return only: on
 * Electron and iOS, checkout opens in an external browser and this document is
 * never unloaded, so the module is still alive to serve the stash back. On web
 * the redirect tears the document down, so a browser whose sessionStorage
 * throws keeps no stash at all and the takeover draws its breathing
 * placeholder through the wait instead.
 *
 * Served ONLY when sessionStorage is unreachable, or when the last write never
 * reached it. Otherwise a readable null is authoritative absence, which is what
 * makes logout's blanket `sessionStorage.clear()` able to kill the stash
 * outright.
 */
let inMemoryStash: TakeoverAvatarStash | null = null;

/**
 * Whether the last write never reached sessionStorage. `setItem` throwing while
 * `getItem` still answers is the real failure mode (private mode, quota), and
 * it is the only case where a readable-empty read may fall back to the mirror.
 */
let storageWriteFailed = false;

/**
 * Bumped by every write, so a reader that snapshotted the stash can tell its
 * copy went stale. Needed because native checkout hands off to an external
 * browser without unloading the document: the takeover's host is already
 * mounted when the stash is written, so a once-per-mount read would keep
 * serving the null it saw before the hand-off.
 *
 * Read during render with no subscription, so a bump only lands on the next
 * externally-triggered render; the takeover's open flip guarantees one on the
 * path that matters.
 */
let version = 0;

/** @see {@link version} */
export function takeoverAvatarStashVersion(): number {
  return version;
}

export function saveTakeoverAvatarStash(
  stash: Omit<TakeoverAvatarStash, "savedAt">,
): void {
  const stamped: TakeoverAvatarStash = { ...stash, savedAt: Date.now() };
  inMemoryStash = stamped;
  version += 1;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
    storageWriteFailed = false;
  } catch {
    // sessionStorage may be unavailable (private mode, quota). Never block the
    // checkout redirect over it; the mirror carries the stash instead.
    storageWriteFailed = true;
  }
}

/**
 * The stashed avatar, or `null` when absent, unparsable, malformed, or older
 * than the TTL: anything unusable is cleared so it can't resurface. Falls back
 * to the in-memory mirror only when sessionStorage is unreachable or the last
 * write never reached it; a readable sessionStorage is otherwise authoritative,
 * empty included.
 */
export function readTakeoverAvatarStash(): TakeoverAvatarStash | null {
  // A failed write means the mirror is strictly newer than anything persisted:
  // a stale earlier stash may still sit in storage, and serving it would show
  // the previous capture's avatar over the fresh one.
  if (storageWriteFailed) {
    return readInMemoryStash();
  }
  let raw: string | null;
  try {
    // Even the property getter can throw (SecurityError in embedded
    // contexts), so the whole acquisition stays inside the guard.
    if (typeof sessionStorage === "undefined") {
      return readInMemoryStash();
    }
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // sessionStorage unreachable, fall back to the in-memory mirror.
    return readInMemoryStash();
  }
  if (!raw) {
    // Readable-empty is authoritative for a stash that did reach storage, so a
    // logout wipe takes the mirror with it.
    inMemoryStash = null;
    return null;
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
  storageWriteFailed = false;
  version += 1;
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
 * Every pro-checkout redirect site calls this, and every call either writes a
 * fresh stash or removes a stale one, so a previous user's (or a previous
 * avatar's) stash can never ride along with a new checkout.
 *
 * Only a hydrated list holding exactly one assistant is captured: the takeover
 * draws the onboarding payload's primary, which need not be the active one, and
 * it draws before that target resolves. Capturing only where the two cannot
 * disagree costs everyone else the instant avatar and buys the guarantee
 * outright.
 */
export function captureTakeoverAvatarStash(queryClient: QueryClient): void {
  const {
    activeAssistantId: assistantId,
    assistants,
    assistantsHydrated,
  } = useResolvedAssistantsStore.getState();
  // The single-assistant org has to be positively known: the list starts empty
  // while a persisted `activeAssistantId` already reads through, so an
  // unhydrated read cannot tell a solo org from a multi-assistant one. The
  // sole entry must also BE the active id: the list and the lifecycle update
  // independently, so a freshly replaced list can briefly outlive a stale
  // active id that no longer names its one assistant.
  if (
    !assistantId ||
    !assistantsHydrated ||
    assistants.length !== 1 ||
    assistants[0]?.id !== assistantId
  ) {
    clearTakeoverAvatarStash();
    return;
  }

  const data = freshestCachedAvatar(queryClient, assistantId);

  // A custom image is a blob URL, dead after the reload, so the takeover's
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
 * The most recently updated avatar cache entry for an assistant. The live query
 * key appends a `supportsManifest` boolean, so both variants can sit in the
 * cache at once and insertion order says nothing about which is current.
 * Newest data wins: recomputing the flag here would couple this module to the
 * backwards-compat resolver.
 */
function freshestCachedAvatar(
  queryClient: QueryClient,
  assistantId: string,
): AvatarData | undefined {
  const matches = queryClient
    .getQueryCache()
    .findAll({ queryKey: avatarQueryKey(assistantId) });

  let freshest: AvatarData | undefined;
  let freshestAt = -Infinity;
  for (const query of matches) {
    const data = query.state.data as AvatarData | undefined;
    if (data === undefined || query.state.dataUpdatedAt < freshestAt) {
      continue;
    }
    freshest = data;
    freshestAt = query.state.dataUpdatedAt;
  }
  return freshest;
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
 * Shape check only: `ChatAvatar` is defensive about component contents, so this
 * rejects garbage rather than deep-guarding the whole component tree. Each
 * array below is dereferenced unconditionally while rendering the creature.
 */
/**
 * True while the record is inside its TTL. Exposed because the surface hook's
 * memoized read can outlive the deadline on a mounted native return, so
 * freshness is rechecked per render rather than trusted from the cached read.
 */
export function isTakeoverAvatarStashFresh(stash: TakeoverAvatarStash): boolean {
  return Date.now() - stash.savedAt <= MAX_AGE_MS;
}

function isTakeoverAvatarStash(value: unknown): value is TakeoverAvatarStash {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const stash = value as Record<string, unknown>;
  if (typeof stash.assistantId !== "string") {
    return false;
  }
  if (typeof stash.savedAt !== "number") {
    return false;
  }
  if (stash.traits !== null && !isCharacterTraits(stash.traits)) {
    return false;
  }
  const components = stash.components;
  if (typeof components !== "object" || components === null) {
    return false;
  }
  const parts = components as Record<string, unknown>;
  if (
    !isNonEmptyArrayOf(parts.bodyShapes, isBodyShapeEntry) ||
    !isNonEmptyArrayOf(parts.eyeStyles, isEyeStyleEntry) ||
    !isNonEmptyArrayOf(parts.colors, isColorEntry) ||
    !Array.isArray(parts.faceCenterOverrides) ||
    !parts.faceCenterOverrides.every(isFaceCenterOverrideEntry)
  ) {
    return false;
  }
  // Well-shaped trait ids that are missing from the stashed definitions would
  // throw in resolveDefinitions, so each one has to resolve here.
  if (stash.traits !== null) {
    const traits = stash.traits as CharacterTraits;
    return (
      hasEntryWithId(parts.bodyShapes, traits.bodyShape) &&
      hasEntryWithId(parts.eyeStyles, traits.eyeStyle) &&
      hasEntryWithId(parts.colors, traits.color)
    );
  }
  return true;
}

function hasEntryWithId(entries: unknown[], id: string): boolean {
  return entries.some(
    (entry) => (entry as Record<string, unknown>).id === id,
  );
}

// Entry-level guards mirror what the render path dereferences unconditionally
// (resolveDefinitions/computeTransforms and AnimatedAvatar read viewBox,
// sourceViewBox, eyeCenter, faceCenter, svgPath, paths, and hex on whichever
// entry the traits select), so a cross-version or corrupted record is rejected
// here instead of crashing the takeover mid-provisioning.

function isNonEmptyArrayOf(
  value: unknown,
  guard: (entry: unknown) => boolean,
): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every(guard);
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function isBox(value: unknown): value is { width: number; height: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const box = value as Record<string, unknown>;
  return typeof box.width === "number" && typeof box.height === "number";
}

function isBodyShapeEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.svgPath === "string" &&
    isBox(entry.viewBox) &&
    isPoint(entry.faceCenter)
  );
}

function isEyeStyleEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    !isBox(entry.sourceViewBox) ||
    !isPoint(entry.eyeCenter) ||
    !Array.isArray(entry.paths)
  ) {
    return false;
  }
  return entry.paths.every((path) => {
    if (typeof path !== "object" || path === null) {
      return false;
    }
    const p = path as Record<string, unknown>;
    return typeof p.svgPath === "string" && typeof p.color === "string";
  });
}

function isColorEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.hex === "string";
}

function isFaceCenterOverrideEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.bodyShape === "string" &&
    typeof entry.eyeStyle === "string" &&
    isPoint(entry.faceCenter)
  );
}

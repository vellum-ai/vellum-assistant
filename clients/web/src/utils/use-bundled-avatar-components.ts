import { useEffect, useState } from "react";

import type { CharacterComponents } from "@/types/avatar";

// Module-level cache so the dynamic import resolves once per session even if
// multiple chips mount in parallel during the same render pass.
let cached: CharacterComponents | null = null;
let loadPromise: Promise<CharacterComponents> | null = null;

// Subscribers fire exactly once, when `cached` is first populated, so that
// hook instances that mounted *before* the load completed (and whose effect
// observed only the still-null state) re-render and pick up the new value
// instead of staying blank for their lifetime.
const subscribers = new Set<() => void>();

// One short-delay retry per session if the first import attempt fails (e.g.
// a transient network blip). If the retry also fails we stop trying and let
// the placeholder stand — the next re-mount will get a fresh shot via the
// `loadPromise = null` path below. Keeping this single-shot avoids spamming
// retries against a stale-deployed chunk that's genuinely gone.
const RETRY_DELAY_MS = 3000;
let retryScheduled = false;

function loadBundledComponents(): Promise<CharacterComponents> {
  if (cached) return Promise.resolve(cached);
  if (loadPromise) return loadPromise;
  loadPromise = import("@/utils/avatar-bundled-components")
    .then((m) => {
      cached = m.BUNDLED_COMPONENTS;
      loadPromise = null;
      for (const cb of subscribers) cb();
      return cached;
    })
    .catch((err) => {
      // Don't leave a rejected promise cached — that would permanently
      // poison every future caller (re-mounts, new subagent spawns, etc.)
      // and avatars would silently stay blank for the rest of the session.
      // Clearing it here lets the next consumer kick off a fresh import.
      loadPromise = null;
      // Schedule a single retry so already-mounted hooks recover from a
      // transient failure even when no new consumer arrives to trigger
      // another attempt. Gated on having active subscribers so we don't
      // burn the retry on a no-longer-visible UI.
      if (!retryScheduled && subscribers.size > 0) {
        retryScheduled = true;
        setTimeout(() => {
          if (!cached && subscribers.size > 0) {
            loadBundledComponents().catch(() => {
              // Final attempt; placeholder stands.
            });
          }
        }, RETRY_DELAY_MS);
      }
      throw err;
    });
  return loadPromise;
}

/**
 * Eagerly kick off the bundled-avatar import without mounting a consumer, so
 * the (~48 kB) chunk is already in flight — or resolved — by the time the
 * avatars first render. Safe to call repeatedly: it no-ops once cached / in
 * flight. Call it as early as a screen full of avatars is known to be coming
 * (e.g. at the onboarding route's module scope) to cut the blank-then-pop gap.
 */
export function preloadBundledAvatarComponents(): void {
  void loadBundledComponents().catch(() => {
    // Best-effort warm-up; the hook's own retry path handles real failures.
  });
}

/**
 * Lazily loads the bundled avatar character-components data (~48 kB of
 * inline SVG paths) on first mount of any consumer. Returns `null` until
 * the chunk resolves; the caller renders a placeholder of the same size so
 * layout doesn't reflow when the avatar pops in.
 *
 * Splitting the data out keeps it off the chat-critical bundle —
 * `SubagentAvatarChip` consumes it inline in transcript items, and a
 * static import would pull the whole payload into the main chunk.
 *
 * If the first import rejects (network blip, stale deployed chunk), the
 * loader clears its cached promise so a re-mount can retry, and mounted
 * instances subscribe to the next successful resolution so a retry
 * triggered by any other consumer fills their UI too.
 */
export function useBundledAvatarComponents(): CharacterComponents | null {
  // We don't store `components` in local state — the module-level `cached`
  // is the source of truth across all hook instances. `forceRender` exists
  // only to schedule a re-read of `cached` when the subscriber notifies.
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    const onLoaded = () => {
      if (!cancelled) forceRender((n) => n + 1);
    };
    subscribers.add(onLoaded);
    void loadBundledComponents().catch(() => {
      // Swallowed here: the loader rethrows for any awaiting caller, so
      // anything wrapping this in a Suspense/ErrorBoundary will still see
      // the failure. The hook's job is just to stay in the placeholder
      // state until a future retry succeeds.
    });
    return () => {
      cancelled = true;
      subscribers.delete(onLoaded);
    };
  }, []);

  return cached;
}

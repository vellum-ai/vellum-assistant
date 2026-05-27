import { useEffect, useState } from "react";

import type { CharacterComponents } from "@/types/avatar";

// Module-level cache so the dynamic import resolves once per session even if
// multiple chips mount in parallel during the same render pass.
let cached: CharacterComponents | null = null;
let loadPromise: Promise<CharacterComponents> | null = null;

function loadBundledComponents(): Promise<CharacterComponents> {
  if (cached) return Promise.resolve(cached);
  if (loadPromise) return loadPromise;
  loadPromise = import("@/utils/avatar-bundled-components")
    .then((m) => {
      cached = m.BUNDLED_COMPONENTS;
      loadPromise = null;
      return cached;
    })
    .catch((err) => {
      // Don't leave a rejected promise cached — that would permanently
      // poison every future caller (re-mounts, new subagent spawns, etc.)
      // and avatars would silently stay blank for the rest of the session.
      // Clearing it here lets the next consumer kick off a fresh import.
      loadPromise = null;
      throw err;
    });
  return loadPromise;
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
 */
export function useBundledAvatarComponents(): CharacterComponents | null {
  const [components, setComponents] = useState<CharacterComponents | null>(
    () => cached,
  );

  useEffect(() => {
    if (components) return;
    let cancelled = false;
    void loadBundledComponents().then((c) => {
      if (!cancelled) setComponents(c);
    });
    return () => {
      cancelled = true;
    };
  }, [components]);

  return components;
}

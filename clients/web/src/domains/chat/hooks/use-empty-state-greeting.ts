/**
 * React hook that fetches personalized empty-state greetings from the daemon.
 *
 * Makes a single request that returns multiple greeting variations as a JSON
 * array, caches them per assistantId, and picks a random one on each new
 * conversation or page refresh. Falls back to {@link DEFAULT_EMPTY_STATE_GREETING}
 * while loading or on error.
 */

import { useEffect, useMemo, useState } from "react";

import { fetchGreetingPool } from "@/domains/chat/api/stream-greeting";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

export interface EmptyStateGreeting {
  /** The greeting to render (defaults until the first token streams in). */
  greeting: string;
  /** True while generating and no text has arrived yet — render a spinner. */
  isGenerating: boolean;
}

interface UseEmptyStateGreetingParams {
  assistantId: string | null | undefined;
  /** Identifies the current empty conversation; a change regenerates. */
  conversationId: string | null | undefined;
  /** Only generate while the empty state is actually shown. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Module-level greeting cache — persists across mounts, resets on page reload.
// ---------------------------------------------------------------------------

interface GreetingCache {
  greetings: string[];
  loading: boolean;
}

const greetingCacheMap = new Map<string, GreetingCache>();

/** Pick a random greeting from the cached pool. */
function pickCachedGreeting(assistantId: string): string | null {
  const entry = greetingCacheMap.get(assistantId);
  if (!entry || entry.greetings.length === 0) {
    return null;
  }
  const idx = Math.floor(Math.random() * entry.greetings.length);
  return entry.greetings[idx]!;
}

/**
 * Fetches the greeting pool in a single request and populates the cache.
 * No-ops if a load is already in progress or cache is already populated.
 */
async function loadGreetingPool(
  assistantId: string,
  signal: AbortSignal,
): Promise<string[]> {
  const existing = greetingCacheMap.get(assistantId);
  if (existing?.loading || (existing && existing.greetings.length > 0)) {
    return existing.greetings;
  }

  const cache: GreetingCache = { greetings: [], loading: true };
  greetingCacheMap.set(assistantId, cache);

  try {
    const greetings = await fetchGreetingPool({ assistantId, signal });
    cache.greetings = greetings;
    return greetings;
  } catch {
    return [];
  } finally {
    cache.loading = false;
  }
}

export function useEmptyStateGreeting({
  assistantId,
  conversationId,
  enabled = true,
}: UseEmptyStateGreetingParams): EmptyStateGreeting {
  const cachedPick = useMemo(
    () => {
      if (!assistantId || !conversationId) {
        return null;
      }
      return pickCachedGreeting(assistantId);
    },
    [assistantId, conversationId],
  );

  const [greeting, setGreeting] = useState(cachedPick ?? "");
  const [isGenerating, setIsGenerating] = useState(() =>
    Boolean(enabled && assistantId && conversationId && !cachedPick),
  );

  useEffect(() => {
    if (!enabled || !assistantId || !conversationId) {
      return;
    }

    if (cachedPick) {
      setGreeting(cachedPick);
      setIsGenerating(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setGreeting("");
    setIsGenerating(true);

    loadGreetingPool(assistantId, controller.signal).then((greetings) => {
      if (!active) {
        return;
      }
      if (greetings.length > 0) {
        const idx = Math.floor(Math.random() * greetings.length);
        setGreeting(greetings[idx]!);
      } else {
        setGreeting(DEFAULT_EMPTY_STATE_GREETING);
      }
      setIsGenerating(false);
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [assistantId, conversationId, enabled, cachedPick]);

  return {
    greeting: greeting || DEFAULT_EMPTY_STATE_GREETING,
    isGenerating: isGenerating && greeting.length === 0,
  };
}

// Exported for testing
export { greetingCacheMap };

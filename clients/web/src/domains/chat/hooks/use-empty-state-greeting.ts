/**
 * React hook that streams personalized empty-state greetings from the daemon.
 *
 * Loads {@link GREETING_POOL_SIZE} variations in parallel on first mount and
 * caches them per assistantId. On each new conversation (or page refresh),
 * a random cached greeting is selected immediately — no spinner, no network
 * round-trip. Falls back to {@link DEFAULT_EMPTY_STATE_GREETING} while the
 * pool is still loading or on error.
 */

import { useEffect, useMemo, useState } from "react";

import { streamEmptyStateGreeting } from "@/domains/chat/api/stream-greeting";
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

/** Number of greeting variations to pre-generate and cache. */
const GREETING_POOL_SIZE = 5;

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
  if (!entry || entry.greetings.length === 0) return null;
  const idx = Math.floor(Math.random() * entry.greetings.length);
  return entry.greetings[idx]!;
}

/**
 * Kicks off parallel greeting generation requests and populates the cache.
 * No-ops if a load is already in progress for this assistantId.
 */
function loadGreetingPool(
  assistantId: string,
  signal: AbortSignal,
  onFirstGreeting: (text: string) => void,
): void {
  const existing = greetingCacheMap.get(assistantId);
  if (existing?.loading || (existing && existing.greetings.length >= GREETING_POOL_SIZE)) {
    return;
  }

  const cache: GreetingCache = { greetings: existing?.greetings ?? [], loading: true };
  greetingCacheMap.set(assistantId, cache);

  let firstFired = false;
  const remaining = GREETING_POOL_SIZE - cache.greetings.length;

  const promises = Array.from({ length: remaining }, () =>
    streamEmptyStateGreeting({ assistantId, signal })
      .then((text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        cache.greetings.push(trimmed);
        if (!firstFired) {
          firstFired = true;
          onFirstGreeting(trimmed);
        }
      })
      .catch(() => {
        // Individual request failures are fine — we just end up with fewer
        // cached greetings. The UI falls back to the default if none succeed.
      }),
  );

  void Promise.allSettled(promises).then(() => {
    cache.loading = false;
  });
}

export function useEmptyStateGreeting({
  assistantId,
  conversationId,
  enabled = true,
}: UseEmptyStateGreetingParams): EmptyStateGreeting {
  // Pick a greeting on mount / conversation change. If the cache is warm we
  // resolve immediately; otherwise we wait for the pool to load.
  const cachedPick = useMemo(
    () => {
      if (!assistantId || !conversationId) return null;
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

    // If we already picked a cached greeting, nothing to do.
    if (cachedPick) {
      setGreeting(cachedPick);
      setIsGenerating(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    let resolved = false;
    setGreeting("");
    setIsGenerating(true);

    loadGreetingPool(assistantId, controller.signal, (text) => {
      if (active && !resolved) {
        resolved = true;
        setGreeting(text);
        setIsGenerating(false);
      }
    });

    // If all requests fail, the onFirstGreeting callback never fires.
    // Poll until the cache finishes loading, then fall back to default.
    const fallbackInterval = setInterval(() => {
      const entry = greetingCacheMap.get(assistantId);
      if (!entry?.loading) {
        clearInterval(fallbackInterval);
        if (active && !resolved) {
          resolved = true;
          const picked = pickCachedGreeting(assistantId);
          setGreeting(picked ?? DEFAULT_EMPTY_STATE_GREETING);
          setIsGenerating(false);
        }
      }
    }, 200);

    return () => {
      active = false;
      clearInterval(fallbackInterval);
      controller.abort();
    };
  }, [assistantId, conversationId, enabled, cachedPick]);

  return {
    greeting: greeting || DEFAULT_EMPTY_STATE_GREETING,
    isGenerating: isGenerating && greeting.length === 0,
  };
}

// Exported for testing
export { greetingCacheMap, GREETING_POOL_SIZE };

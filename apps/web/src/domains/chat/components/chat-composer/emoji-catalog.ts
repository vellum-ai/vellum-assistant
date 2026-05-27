/**
 * Public API for the emoji autocomplete popup. The actual catalog (~150 kB of
 * data) lives in `emoji-catalog-data.ts` and is loaded on first use via the
 * `useEmojiSearch` hook so it stays out of the initial bundle.
 *
 * Re-exports the `EmojiEntry` type from the data module so consumers don't
 * have to know about the split.
 */

import { useEffect, useState } from "react";

export type { EmojiEntry } from "./emoji-catalog-data";
import type { EmojiEntry } from "./emoji-catalog-data";

/**
 * Matches `:shortcode` at the end of text up to the cursor position.
 * Allows `+` and `-` so shortcodes like `:+1` and `:-1` are matched.
 */
export const EMOJI_TRIGGER_RE = /:([\w+-]+)$/;

/** Minimum filter length before showing the emoji popup. */
export const EMOJI_MIN_FILTER_LENGTH = 2;

type SearchFn = (query: string, limit?: number) => EmojiEntry[];

const EMPTY_RESULT: EmojiEntry[] = [];

const emptySearch: SearchFn = () => EMPTY_RESULT;

let cachedSearch: SearchFn | null = null;
let loadPromise: Promise<SearchFn> | null = null;

function loadEmojiSearch(): Promise<SearchFn> {
  if (cachedSearch) return Promise.resolve(cachedSearch);
  if (loadPromise) return loadPromise;
  loadPromise = import("./emoji-catalog-data").then((m) => {
    cachedSearch = m.searchEmoji;
    return cachedSearch;
  });
  return loadPromise;
}

/**
 * Returns a `searchEmoji` function that becomes useful after the emoji
 * catalog has loaded. Until then it returns an empty array, keeping the
 * popup hidden but not blocking input. On subsequent renders (after load),
 * the returned function performs real lookups.
 */
export function useEmojiSearch(): SearchFn {
  const [search, setSearch] = useState<SearchFn>(() => cachedSearch ?? emptySearch);

  useEffect(() => {
    if (cachedSearch) return;
    let cancelled = false;
    void loadEmojiSearch().then((fn) => {
      if (!cancelled) setSearch(() => fn);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return search;
}

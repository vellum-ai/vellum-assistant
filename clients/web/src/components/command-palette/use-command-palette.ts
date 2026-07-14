
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { GlobalSearchResponse } from "@/domains/chat/api/global-search";
import { searchGlobal } from "@/domains/chat/api/global-search";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

export interface UseCommandPaletteOptions {
  /** Total number of items in the results list, for bounds clamping. Can be a number or a getter function for lazy evaluation to avoid stale closure issues. */
  itemCount: number | (() => number);
  /** Called when Enter is pressed on the selected item. */
  onSelect?: (index: number) => void;
  /** Assistant ID for server-side global search. If omitted, search is disabled. */
  assistantId?: string | null;
  /** Controlled open state for standalone hosts such as the floating window. */
  isOpen?: boolean;
  /** Called when the palette closes, after local state has reset. */
  onClose?: () => void;
}

export interface UseCommandPaletteReturn {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  /** Whether a server search is currently in-flight. */
  isSearching: boolean;
  /** Server search results, grouped by category. */
  searchResults: GlobalSearchResponse | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (value: string) => void;
  /** Key-down handler to attach to the palette container or input. */
  handleKeyDown: (e: KeyboardEvent) => void;
}

const DEBOUNCE_MS = 150;
const MIN_QUERY_LENGTH = 2;

/**
 * Hook managing the command palette state: open/close toggle, search query,
 * keyboard navigation (arrow up/down, Enter, Escape), and debounced server
 * search via the daemon's global search API.
 */
export function useCommandPalette({
  itemCount: itemCountProp,
  onSelect,
  assistantId,
  isOpen: controlledIsOpen,
  onClose,
}: UseCommandPaletteOptions): UseCommandPaletteReturn {
  const storeIsOpen = useCommandPaletteStore.use.isOpen();
  const isOpen = controlledIsOpen ?? storeIsOpen;
  const storeOpen = useCommandPaletteStore.use.open();
  const storeClose = useCommandPaletteStore.use.close();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<GlobalSearchResponse | null>(null);

  const itemCountGetterRef = useRef<() => number>(() => 0);
  useLayoutEffect(() => {
    itemCountGetterRef.current = typeof itemCountProp === "function" ? itemCountProp : () => itemCountProp;
  });

  // Refs for debounce + abort management.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelSearch = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const open = useCallback(() => {
    storeOpen();
    setSelectedIndex(0);
  }, [storeOpen]);

  const close = useCallback(() => {
    storeClose();
    setQuery("");
    setSelectedIndex(0);
    setIsSearching(false);
    setSearchResults(null);
    cancelSearch();
    onClose?.();
  }, [storeClose, cancelSearch, onClose]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }, [isOpen, close, open]);

  // Reset local state when palette is closed externally (e.g. via the
  // store's toggle called from the layout-level search button).
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setIsSearching(false);
      setSearchResults(null);
      cancelSearch();
    }
  }, [isOpen, cancelSearch]);

  /**
   * Trigger a debounced search for the given query value. Immediately clears
   * results if the query is below the minimum length threshold.
   */
  const triggerSearch = useCallback(
    (q: string) => {
      cancelSearch();

      const trimmed = q.trim();
      if (trimmed.length < MIN_QUERY_LENGTH || !assistantId) {
        setIsSearching(false);
        setSearchResults(null);
        return;
      }

      setIsSearching(true);

      debounceTimerRef.current = setTimeout(() => {
        if (!assistantId) {
          setIsSearching(false);
          return;
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;

        searchGlobal(assistantId, trimmed, {
          signal: controller.signal,
        })
          .then((results) => {
            if (abortControllerRef.current === controller) {
              setSearchResults(results);
              setIsSearching(false);
            }
          })
          .catch(() => {
            if (abortControllerRef.current === controller) {
              setIsSearching(false);
            }
          });
      }, DEBOUNCE_MS);
    },
    [cancelSearch, assistantId],
  );

  const handleSetQuery = useCallback(
    (value: string) => {
      setQuery(value);
      setSelectedIndex(0);
      triggerSearch(value);
    },
    [triggerSearch],
  );

  // Cleanup on unmount — cancel in-flight searches.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Cmd+K / Ctrl+K toggles the palette closed even when input is focused.
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        close();
        return;
      }

      const count = itemCountGetterRef.current();
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (count > 0) {
            setSelectedIndex((prev) => Math.min(prev + 1, count - 1));
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (count > 0) {
            onSelect?.(selectedIndex);
          }
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [onSelect, selectedIndex, close],
  );

  return {
    isOpen,
    query,
    selectedIndex,
    isSearching,
    searchResults,
    open,
    close,
    toggle,
    setQuery: handleSetQuery,
    handleKeyDown,
  };
}

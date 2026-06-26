/**
 * Small local stick-to-bottom coordinator for the ACP chat view.
 *
 * The shared `useTranscriptScroll` is built around the paginated
 * `TranscriptHandle` / `TranscriptItem` contract (load-older anchoring,
 * conversationId reset). The ACP chat view has none of that — no pagination,
 * no transcript handle — so wiring the full contract would be heavier than the
 * behavior warrants. This hook covers exactly what the chat view needs:
 *
 *   1. Pin the scroll container to the bottom as content streams in, but only
 *      while the user is already near the bottom (so a user who scrolled up to
 *      read isn't yanked back down).
 *   2. Surface a "Go to newest" affordance (`showScrollToLatest`) when the user
 *      has scrolled away from the bottom.
 *
 * happy-dom has no layout, so `scrollHeight`/`clientHeight` are 0 in tests —
 * the math degrades gracefully (everything reads as "pinned"), which is the
 * intended default.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Distance (px) from the bottom within which we treat the user as "pinned". */
const PIN_THRESHOLD = 80;

export interface UseStickToBottomReturn {
  // Callback ref so the scroll listener follows the node across remounts (see impl).
  scrollRef: (node: HTMLDivElement | null) => void;
  showScrollToLatest: boolean;
  scrollToLatest: () => void;
}

function isNearBottom(el: HTMLElement): boolean {
  const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
  return distance <= PIN_THRESHOLD;
}

export function useStickToBottom(contentKey: unknown): UseStickToBottomReturn {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is currently pinned to the bottom. Seeded true so a fresh
  // run lands at the latest block.
  const pinnedRef = useRef(true);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const pinToBottom = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const reclassify = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    const pinned = isNearBottom(el);
    pinnedRef.current = pinned;
    setShowScrollToLatest((prev) => (prev === !pinned ? prev : !pinned));
  }, []);

  const scrollToLatest = useCallback(() => {
    pinnedRef.current = true;
    pinToBottom();
    setShowScrollToLatest(false);
  }, [pinToBottom]);

  // Callback ref so the scroll listener always tracks the mounted node. When
  // the conversation div unmounts (a file diff opens) React calls this with
  // null — detach; when it remounts on Back, React calls it with the new node —
  // reattach and re-pin. A stable ref + effect wouldn't rerun, stranding the
  // listener on the detached node.
  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      const prev = nodeRef.current;
      if (prev) prev.removeEventListener("scroll", reclassify);
      nodeRef.current = node;
      if (!node) return;
      node.addEventListener("scroll", reclassify, { passive: true });
      // Land at the latest (or surface the affordance) on (re)mount.
      if (pinnedRef.current) node.scrollTop = node.scrollHeight;
      else reclassify();
    },
    [reclassify],
  );

  // Re-pin (or surface the affordance) whenever the content identity changes.
  // useLayoutEffect so the pin lands before paint and there's no visible jump.
  useLayoutEffect(() => {
    if (pinnedRef.current) pinToBottom();
    else reclassify();
  }, [contentKey, pinToBottom, reclassify]);

  return { scrollRef, showScrollToLatest, scrollToLatest };
}

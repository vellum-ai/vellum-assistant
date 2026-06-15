/**
 * Deep-link: scroll to and highlight a specific message.
 *
 * When the chat route carries a `?message=<id>` search param (e.g. from the
 * "Open" button on a saved bookmark), this hook drives the transcript to scroll
 * that message into view and flash it. It polls for the message's DOM anchor
 * for a bounded window because the conversation's history loads asynchronously
 * after navigation; once found (or the window elapses) it clears the param so
 * the jump fires exactly once.
 *
 * Limitation: if the target lives in an older history page that hasn't been
 * loaded, its anchor never appears and the hook gives up silently. Forcing
 * older pages to load until the message is present is a future enhancement.
 */

import { useEffect } from "react";
import type { RefObject } from "react";
import type { SetURLSearchParams } from "react-router";

import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import { SCROLL_TO_MESSAGE_PARAM } from "@/utils/routes";

/** Poll cadence and ceiling — ~3s total to cover async history settling. */
const POLL_INTERVAL_MS = 150;
const MAX_ATTEMPTS = 20;

export function useScrollToMessageParam(args: {
  transcriptRef: RefObject<TranscriptHandle | null>;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  conversationId: string | null;
}): void {
  const { transcriptRef, searchParams, setSearchParams, conversationId } = args;
  const targetMessageId = searchParams.get(SCROLL_TO_MESSAGE_PARAM);

  useEffect(() => {
    if (!targetMessageId) return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearParam = () => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete(SCROLL_TO_MESSAGE_PARAM);
          return next;
        },
        { replace: true },
      );
    };

    const attempt = () => {
      if (cancelled) return;
      attempts += 1;
      const found = transcriptRef.current?.scrollToMessage(targetMessageId) ?? false;
      if (found || attempts >= MAX_ATTEMPTS) {
        clearParam();
        return;
      }
      timer = setTimeout(attempt, POLL_INTERVAL_MS);
    };

    timer = setTimeout(attempt, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `conversationId` re-arms the jump when navigating between threads.
  }, [targetMessageId, conversationId, transcriptRef, setSearchParams]);
}

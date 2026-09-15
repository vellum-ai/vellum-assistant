/** Pure classification helpers for the transcript scroll coordinator.
 *
 *  Separated from the React hook (`useTranscriptScroll`) so they can be
 *  unit-tested without a component render cycle. The hook wires these
 *  into scroll events and React state; these functions own the math. */

import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { DisplayMessage } from "@/domains/chat/types/types";

import { isCameraFrameRow } from "./camera-frame-rows";

// ---------------------------------------------------------------------------
// Thresholds (load-bearing — keep exact).
// ---------------------------------------------------------------------------

/** Distance from bottom (in px) at or below which the transcript is
 *  considered pinned to latest. In flex-col, this is
 *  `scrollHeight − clientHeight − scrollTop`. */
export const PINNED_THRESHOLD_PX = 64;

/** Distance from bottom (in px) above which the "Go to Newest"
 *  affordance is shown. */
export const SHOW_SCROLL_BUTTON_THRESHOLD_PX = 240;

/** Distance from the TOP of scrollable content (in px) at or below which
 *  an older-page load is triggered. In flex-col, the top of scrollable
 *  content (oldest messages) is at `scrollTop = 0`. */
export const LOAD_OLDER_THRESHOLD_PX = 200;

// ---------------------------------------------------------------------------
// Pure classification helpers
// ---------------------------------------------------------------------------

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollClassification {
  distanceFromBottom: number;
  isPinned: boolean;
  showScrollToLatest: boolean;
  shouldLoadOlder: boolean;
}

/** Pure classification of a scroll position against the load-bearing
 *  thresholds above.
 *
 *  In flex-col (chronological) layout:
 *    - distanceFromTop    = scrollTop
 *    - distanceFromBottom = scrollHeight − clientHeight − scrollTop
 *
 *  iOS rubber-band can briefly push scrollTop outside [0, max], so we
 *  clamp distanceFromBottom at 0 to avoid spurious pill flicker.
 */
export function classifyScrollPosition(
  metrics: ScrollMetrics,
  flags: {
    hasMore: boolean;
    isLoadingOlder: boolean;
    hasConversation: boolean;
  },
): ScrollClassification {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const distanceFromBottom = Math.max(0, maxScrollTop - metrics.scrollTop);
  const distanceFromTop = Math.max(0, metrics.scrollTop);
  const isPinned = distanceFromBottom <= PINNED_THRESHOLD_PX;
  const showScrollToLatest =
    distanceFromBottom > SHOW_SCROLL_BUTTON_THRESHOLD_PX;
  const shouldLoadOlder =
    flags.hasConversation &&
    flags.hasMore &&
    !flags.isLoadingOlder &&
    distanceFromTop <= LOAD_OLDER_THRESHOLD_PX;
  return { distanceFromBottom, isPinned, showScrollToLatest, shouldLoadOlder };
}

/**
 * Whether two item lists hold the same visible row identities, including
 * frames folded into a message item.
 *
 * Guards the underfilled-viewport auto-fetch against no-progress updates.
 * Reprojected arrays, streaming text, and attachment hydration preserve
 * identity, while a page adding frames changes it even under the same host.
 */
export function haveSameItemKeys(
  a: readonly TranscriptItem[],
  b: readonly TranscriptItem[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => {
      const next = b[i];
      if (item.key !== next?.key) {
        return false;
      }
      const frames = item.kind === "message" ? (item.cameraFrames ?? []) : [];
      const nextFrames =
        next.kind === "message" ? (next.cameraFrames ?? []) : [];
      return (
        frames.length === nextFrames.length &&
        frames.every((frame, index) => {
          const nextFrame = nextFrames[index];
          return nextFrame !== undefined && sameFrameIdentity(nextFrame, frame);
        })
      );
    })
  );
}

/**
 * Whether a history-seeking user gesture should page in older history.
 *
 * An underfilled scroll element is pinned at scrollTop 0 and never fires
 * `scroll`, so the scroll-handler load-older path is unreachable there and
 * the no-progress guard (see {@link haveSameItemKeys}) has stopped the
 * automatic chain. Gestures are the only remaining signal of intent, and
 * each one pages in at most one fetch.
 */
export function shouldGestureLoadOlder(
  metrics: ScrollMetrics,
  flags: {
    hasMore: boolean;
    isLoadingOlder: boolean;
    hasConversation: boolean;
  },
): boolean {
  const underfilled = metrics.scrollHeight <= metrics.clientHeight;
  return (
    underfilled &&
    flags.hasConversation &&
    flags.hasMore &&
    !flags.isLoadingOlder
  );
}

function frameMatchesAnchor(frame: DisplayMessage, key: string): boolean {
  return frame.id === key || frame.clientMessageId === key;
}

function sameFrameIdentity(
  frame: DisplayMessage,
  previous: DisplayMessage,
): boolean {
  return (
    frameMatchesAnchor(frame, previous.id) ||
    (previous.clientMessageId !== undefined &&
      frameMatchesAnchor(frame, previous.clientMessageId))
  );
}

/** Exact row keys take precedence over grouped-frame aliases. Both persisted
 *  frame ids and optimistic client ids survive a group changing its host. */
export function findAnchorIndex(
  items: readonly TranscriptItem[],
  anchorKey: string,
): number {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && item.key === anchorKey) {
      return i;
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (
      item?.kind === "message" &&
      item.cameraFrames?.some((frame) => frameMatchesAnchor(frame, anchorKey))
    ) {
      return i;
    }
  }
  return -1;
}

/** A standalone group's existing frames remain contiguous when pagination
 *  adds earlier frames, even if ambient capture also appends to the run.
 *  Speech rehosting and distinct user turns remain new-anchor events. */
export function isStandaloneCameraFramePrepend(
  previous: TranscriptItem | undefined,
  next: TranscriptItem | undefined,
): boolean {
  if (
    previous?.kind !== "message" ||
    next?.kind !== "message" ||
    !isCameraFrameRow(previous.message) ||
    !isCameraFrameRow(next.message) ||
    !previous.cameraFrames?.length ||
    !next.cameraFrames?.length
  ) {
    return false;
  }
  const nextFrames = next.cameraFrames;
  const first = previous.cameraFrames[0]!;
  const offset = nextFrames.findIndex((frame) =>
    sameFrameIdentity(frame, first),
  );
  return (
    offset > 0 &&
    nextFrames.some((frame) => frameMatchesAnchor(frame, previous.key)) &&
    previous.cameraFrames.every((frame, index) => {
      const candidate = nextFrames[offset + index];
      return candidate !== undefined && sameFrameIdentity(candidate, frame);
    })
  );
}

/** Walk the items list backward and return the key of the most recent
 *  user-role message item — the `LatestTurnRow` "anchor". Returns `null`
 *  when the transcript has no user message (e.g. assistant-only history,
 *  pure trailers, or an empty list). Mirrors `partitionLatestTurn`'s
 *  anchor lookup so the items-effect can detect a new submit without
 *  doing the full partition itself. */
export function findLatestUserAnchorKey(
  items: readonly TranscriptItem[],
): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && item.kind === "message" && item.message.role === "user") {
      return item.key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Items-change decision helper
// ---------------------------------------------------------------------------

export interface AnchorSnapshot {
  key: string;
  scrollTop: number;
  /** scrollHeight captured at the moment the anchor was saved. The
   *  hook restores `scrollTop + (newScrollHeight − savedScrollHeight)`
   *  after the older-page prepend lands, so the user's view stays on
   *  the same row regardless of how many pixels of older content were
   *  inserted above it. */
  scrollHeight: number;
}

export type ItemsChangeAction =
  | { kind: "none" }
  | {
      kind: "anchor-correct";
      newIndex: number;
      savedScrollTop: number;
      savedScrollHeight: number;
    };

export interface ItemsChangeContext {
  items: readonly TranscriptItem[];
  previousItems: readonly TranscriptItem[];
  conversationId: string | null;
  savedAnchor: AnchorSnapshot | null;
}

function hasPrependedItems(
  previousItems: readonly TranscriptItem[],
  items: readonly TranscriptItem[],
): boolean {
  const first = previousItems[0];
  if (!first) {
    return false;
  }
  const index = findAnchorIndex(items, first.key);
  if (index > 0) {
    return true;
  }
  const next = items[index];
  if (
    first.kind !== "message" ||
    next?.kind !== "message" ||
    !next.cameraFrames?.length
  ) {
    return false;
  }
  const firstMessage = first.cameraFrames?.[0] ?? first.message;
  const frameIndex = next.cameraFrames.findIndex((frame) =>
    sameFrameIdentity(frame, firstMessage),
  );
  return (
    frameIndex > 0 ||
    (frameIndex < 0 && sameFrameIdentity(next.message, firstMessage))
  );
}

/** Decide what the scroll coordinator should do in response to an
 *  `items` change. The caller is responsible for executing the action
 *  (calling into the TranscriptHandle) and for updating the
 *  `savedAnchor` bookkeeping state.
 *
 *  Notes:
 *  - "open-to-latest" on conversation switch is handled by the
 *    conversation-reset effect, not here.
 *  - Streaming growth deliberately returns `none` here. The viewport
 *    stays put so the reader is in control; the "Go to Newest" pill
 *    appears once distance-from-bottom crosses its threshold. */
export function decideItemsChangeAction(
  ctx: ItemsChangeContext,
): ItemsChangeAction {
  if (ctx.conversationId === null) {
    return { kind: "none" };
  }

  if (ctx.savedAnchor && hasPrependedItems(ctx.previousItems, ctx.items)) {
    const newIndex = findAnchorIndex(ctx.items, ctx.savedAnchor.key);
    if (newIndex >= 0) {
      return {
        kind: "anchor-correct",
        newIndex,
        savedScrollTop: ctx.savedAnchor.scrollTop,
        savedScrollHeight: ctx.savedAnchor.scrollHeight,
      };
    }
  }

  return { kind: "none" };
}

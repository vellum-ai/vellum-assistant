import { useCallback, useEffect, useState } from "react";

import {
  useElementSize,
  useLayoutViewportSize,
} from "@/hooks/use-element-size";

/** Width of the list column when it sits beside the detail. */
const SIDE_LIST_WIDTH_PX = 320;

/** The `gap-6` between the list column and the detail. */
const SIDE_LIST_GAP_PX = 24;

/**
 * Narrowest detail worth showing beside the list. Below this the detail is a
 * column of single words with its trailing controls clipped, which is worse
 * than reaching the list through the drawer.
 */
const MIN_DETAIL_WIDTH_PX = 296;

/** Pane width at which the list can sit beside the detail rather than behind a trigger. */
const MIN_PANE_WIDTH_PX =
  SIDE_LIST_WIDTH_PX + SIDE_LIST_GAP_PX + MIN_DETAIL_WIDTH_PX;

export interface SideListRoom {
  /** Attach to the pane whose width decides this. Its width must come from its parent. */
  paneRef: (el: HTMLElement | null) => void;
  /** Whether the list fits beside the detail. When false, the drawer carries it. */
  hasRoomForList: boolean;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}

/**
 * One owner for a list-detail pane's two list surfaces: the column beside the
 * detail, and the {@link SideListDrawer} that stands in for it when the pane is
 * too narrow to seat both.
 *
 * The measurement is the pane, not the window, because the pane is what the
 * list has to fit into. These pages render inside the chat layout's content
 * area, so a 230-400px sidebar and the page shell's padding sit between the
 * two: a viewport media query calls a 470px pane roomy at a 768px window and
 * leaves the detail 126px wide with no way to dismiss the list, since its
 * substitute is keyed off the same window width that just declared there was
 * room. Contacts, Channels, and Workspace all sit in that pane.
 *
 * A container query would express the same threshold in CSS, which is the
 * cheaper rung, but it cannot hand the boolean to the drawer's open state,
 * focus trap, and scroll lock. Two surfaces that substitute for each other are
 * one decision, so both read this instead of one hiding itself in CSS while the
 * other mirrors the threshold in JavaScript. See `docs/PLATFORM_ADAPTATION.md`.
 *
 * This is the window-size axis alone. Which overlay a trigger opens is the
 * pointer's question and is not asked here.
 */
export function useSideListRoom(): SideListRoom {
  const { ref: paneRef, size } = useElementSize();
  // A zero box is an unmeasured pane, not a pane with no room: a subtree that
  // has not been laid out reports one, and so does a DOM without a layout
  // engine. Falling through to the window there keeps the answer the same as
  // the one the pane will give once it has a box, rather than flashing the
  // drawer at a reader whose window is plainly wide enough.
  const unmeasured = size.w <= 0;
  const viewport = useLayoutViewportSize(unmeasured);
  const paneWidth = unmeasured ? viewport.w : size.w;
  const hasRoomForList = paneWidth >= MIN_PANE_WIDTH_PX;
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The drawer unmounts the moment the pane can seat the list inline, and the
  // state goes with it: left set, re-narrowing the pane would reopen a drawer
  // nobody asked for.
  useEffect(() => {
    if (hasRoomForList) {
      setDrawerOpen(false);
    }
  }, [hasRoomForList]);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return { paneRef, hasRoomForList, drawerOpen, openDrawer, closeDrawer };
}

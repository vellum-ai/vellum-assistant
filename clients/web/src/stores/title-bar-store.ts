/**
 * Coordinates the Electron window-drag surface between the global fallback
 * strip and a renderer-owned inline title bar.
 *
 * The macOS shell runs with `titleBarStyle: "hidden"`, so the renderer must
 * declare its own `-webkit-app-region: drag` surface (see `WindowDragRegion`).
 * On the main-app chat routes the chat header (`ChatLayoutHeader`) doubles as
 * the macOS title bar — it sits inline with the traffic lights and provides
 * that drag surface itself. The global `WindowDragRegion` strip must step
 * aside there: it renders *outside* `.app-shell` (which is an `isolation:
 * isolate` stacking context), so it would paint over — and out-stack — the
 * header's buttons and swallow their clicks.
 *
 * `ChatLayoutHeader` sets `inlineTitleBarActive` while it's mounted on
 * Electron; `WindowDragRegion` reads it and renders nothing while active. Off
 * Electron nothing sets it and `WindowDragRegion` is already a no-op, so this
 * is inert on web and iOS.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface TitleBarState {
  inlineTitleBarActive: boolean;
}

interface TitleBarActions {
  setInlineTitleBarActive: (active: boolean) => void;
}

type TitleBarStore = TitleBarState & TitleBarActions;

const useTitleBarStoreBase = create<TitleBarStore>((set) => ({
  inlineTitleBarActive: false,
  setInlineTitleBarActive: (active) => set({ inlineTitleBarActive: active }),
}));

export const useTitleBarStore = createSelectors(useTitleBarStoreBase);

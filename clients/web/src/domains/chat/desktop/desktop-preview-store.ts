import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface DesktopPreviewState {
  session: { assistantId: string; view: "preview" | "fullscreen" } | null;
  position: { x: number; y: number } | null;
  width: number;
}

interface DesktopPreviewActions {
  setPosition: (position: { x: number; y: number }) => void;
  resize: (width: number, position: { x: number; y: number }) => void;
  toggle: (assistantId: string) => void;
  setFullscreen: (fullscreen: boolean) => void;
  close: () => void;
}

export const useDesktopPreviewStore = createSelectors(
  create<DesktopPreviewState & DesktopPreviewActions>()((set) => ({
    session: null,
    position: null,
    width: 320,
    resize: (width, position) => set({ width, position }),
    setPosition: (position) => set({ position }),
    toggle: (assistantId) =>
      set((state) => ({
        session:
          state.session?.assistantId === assistantId
            ? null
            : { assistantId, view: "preview" },
      })),
    setFullscreen: (fullscreen) =>
      set((state) => ({
        session: state.session
          ? { ...state.session, view: fullscreen ? "fullscreen" : "preview" }
          : null,
      })),
    close: () => set({ session: null }),
  })),
);

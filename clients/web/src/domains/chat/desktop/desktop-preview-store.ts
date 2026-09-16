import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface DesktopPreviewState {
  inlinePreview: { assistantId: string; container: HTMLDivElement } | null;
  session: { assistantId: string; view: "preview" | "fullscreen" } | null;
  position: { x: number; y: number } | null;
}

interface DesktopPreviewActions {
  setInlinePreview: (preview: DesktopPreviewState["inlinePreview"]) => void;
  openFullscreen: (assistantId: string) => void;
  openPreview: (assistantId: string) => void;
  setPosition: (position: { x: number; y: number }) => void;
  toggle: (assistantId: string) => void;
  setFullscreen: (fullscreen: boolean) => void;
  close: () => void;
}

export const useDesktopPreviewStore = createSelectors(
  create<DesktopPreviewState & DesktopPreviewActions>()((set) => ({
    inlinePreview: null,
    setInlinePreview: (inlinePreview) => set({ inlinePreview }),
    openPreview: (assistantId) =>
      set({ session: { assistantId, view: "preview" } }),
    openFullscreen: (assistantId) =>
      set({ session: { assistantId, view: "fullscreen" } }),
    session: null,
    position: null,
    setPosition: (position) => set({ position }),
    toggle: (assistantId) =>
      set((state) => ({
        session:
          state.session?.assistantId === assistantId
            ? null
            : {
                assistantId,
                view:
                  state.inlinePreview?.assistantId === assistantId
                    ? "fullscreen"
                    : "preview",
              },
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

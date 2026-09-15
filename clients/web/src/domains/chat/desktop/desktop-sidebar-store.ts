import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface DesktopSidebarState {
  session: { assistantId: string; view: "preview" | "fullscreen" } | null;
}

interface DesktopSidebarActions {
  toggle: (assistantId: string) => void;
  setFullscreen: (fullscreen: boolean) => void;
  close: () => void;
}

export const useDesktopSidebarStore = createSelectors(
  create<DesktopSidebarState & DesktopSidebarActions>()((set) => ({
    session: null,
    toggle: (assistantId) => set((state) => ({
      session: state.session?.assistantId === assistantId
        ? null
        : { assistantId, view: "preview" },
    })),
    setFullscreen: (fullscreen) => set((state) => ({
      session: state.session
        ? { ...state.session, view: fullscreen ? "fullscreen" : "preview" }
        : null,
    })),
    close: () => set({ session: null }),
  })),
);

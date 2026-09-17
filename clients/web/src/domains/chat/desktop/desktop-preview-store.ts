import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface DesktopPreviewState {
  inlinePreview: { assistantId: string; container: HTMLDivElement } | null;
  session: { assistantId: string; view: "preview" | "fullscreen" } | null;
  sessionBeforeHelp: DesktopPreviewState["session"];
  submittedHelpRequests: Record<
    string,
    { requestId: string; conversationId: string }
  >;
  position: { x: number; y: number } | null;
  width: number;
}

interface DesktopPreviewActions {
  markHelpSubmitted: (
    assistantId: string,
    requestId: string,
    conversationId: string,
  ) => void;
  resolveHelpSubmission: (requestId: string) => void;
  setInlinePreview: (preview: DesktopPreviewState["inlinePreview"]) => void;
  openFullscreen: (assistantId: string) => void;
  openPreview: (assistantId: string) => void;
  setPosition: (position: { x: number; y: number }) => void;
  resize: (width: number, position: { x: number; y: number }) => void;
  toggle: (assistantId: string, fullscreen?: boolean) => void;
  setFullscreen: (fullscreen: boolean) => void;
  close: () => void;
}

export const useDesktopPreviewStore = createSelectors(
  create<DesktopPreviewState & DesktopPreviewActions>()((set) => ({
    inlinePreview: null,
    sessionBeforeHelp: null,
    submittedHelpRequests: {},
    markHelpSubmitted: (assistantId, requestId, conversationId) =>
      set((state) => ({
        submittedHelpRequests: {
          ...state.submittedHelpRequests,
          [assistantId]: { requestId, conversationId },
        },
      })),
    resolveHelpSubmission: (requestId) =>
      set((state) => ({
        submittedHelpRequests: Object.fromEntries(
          Object.entries(state.submittedHelpRequests).filter(
            ([, request]) => request.requestId !== requestId,
          ),
        ),
        session:
          state.session &&
          state.submittedHelpRequests[state.session.assistantId]?.requestId ===
            requestId
            ? { ...state.session, view: "preview" }
            : state.session,
      })),
    setInlinePreview: (inlinePreview) =>
      set((state) => {
        if (inlinePreview) {
          return {
            inlinePreview,
            sessionBeforeHelp: state.inlinePreview
              ? state.sessionBeforeHelp
              : state.session?.assistantId === inlinePreview.assistantId &&
                  state.session.view === "preview"
                ? state.session
                : null,
          };
        }
        return {
          inlinePreview: null,
          sessionBeforeHelp: null,
          session:
            state.inlinePreview &&
            state.session?.assistantId === state.inlinePreview.assistantId
              ? state.sessionBeforeHelp
              : state.session,
        };
      }),
    openPreview: (assistantId) =>
      set({ session: { assistantId, view: "preview" } }),
    openFullscreen: (assistantId) =>
      set({ session: { assistantId, view: "fullscreen" } }),
    session: null,
    position: null,
    width: 320,
    resize: (width, position) => set({ width, position }),
    setPosition: (position) => set({ position }),
    toggle: (assistantId, fullscreen = false) =>
      set((state) => ({
        session:
          state.session?.assistantId === assistantId
            ? null
            : {
                assistantId,
                view:
                  fullscreen || state.inlinePreview?.assistantId === assistantId
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

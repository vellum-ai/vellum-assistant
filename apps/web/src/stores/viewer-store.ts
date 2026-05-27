/**
 * Zustand store for viewer UI state.
 *
 * Manages panel navigation and the app/document viewer lifecycle as
 * direct named actions.
 *
 * **State managed:**
 * - `mainView` — which top-level panel is displayed
 * - `activeAppId` / `openedAppState` — app viewer
 * - `openedDocumentState` — document viewer
 * - `isAppMinimized` — mobile-only: app viewer minimized
 * - `intelligenceTab` — sub-tab inside the intelligence panel
 * - `assetsRefreshKey` — counter bumped to force asset re-fetches
 * - `viewBeforeDocument` / `viewBeforeSubagentDetail` — previous view for restoration
 * - `activeSubagentId` — subagent detail panel
 *
 * App share/deploy lifecycle lives in `domains/chat/deploy-store.ts`.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import * as Sentry from "@sentry/react";
import { create } from "zustand";

import { appsByIdOpenPost, documentsByIdGet } from "@/generated/daemon/sdk.gen";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MainView = "chat" | "app" | "app-editing" | "document" | "subagent-detail";

export type IntelligenceTab = "identity" | "skills" | "workspace" | "contacts";

export interface OpenedAppState {
  appId: string;
  dirName?: string;
  name: string;
  html: string;
}

export interface OpenedDocumentState {
  surfaceId: string;
  conversationId: string;
  documentName: string;
  content: string;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ViewerState {
  mainView: MainView;
  activeAppId: string | null;
  openedAppState: OpenedAppState | null;
  activeDocumentSurfaceId: string | null;
  openedDocumentState: OpenedDocumentState | null;
  isAppMinimized: boolean;
  intelligenceTab: IntelligenceTab;
  assetsRefreshKey: number;
  viewBeforeDocument: Exclude<MainView, "document" | "subagent-detail">;
  activeSubagentId: string | null;
  viewBeforeSubagentDetail: Exclude<MainView, "document" | "subagent-detail">;
}

export interface ViewerActions {
  // --- View navigation ---
  setMainView: (view: MainView) => void;
  setIntelligenceTab: (tab: IntelligenceTab) => void;

  // --- App viewer ---
  openApp: (appId: string) => void;
  loadApp: (assistantId: string, appId: string) => Promise<void>;
  setLoadedApp: (app: OpenedAppState) => void;
  handleAppLoadFailed: () => void;
  closeApp: () => void;
  toggleAppMinimized: () => void;
  handleAppUnpinned: (appId: string) => void;
  enterAppEditing: () => void;
  exitAppEditing: () => void;

  // --- Subagent detail ---
  openSubagentDetail: (subagentId: string) => void;
  closeSubagentDetail: () => void;

  // --- Document viewer ---
  openDocument: () => void;
  loadDocument: (assistantId: string, documentSurfaceId: string) => Promise<void>;
  setLoadedDocument: (document: OpenedDocumentState) => void;
  updateDocumentContent: (surfaceId: string, content: string, mode: string) => void;
  handleDocumentLoadFailed: () => void;
  closeDocument: () => void;

  // --- Assets ---
  refreshAssets: () => void;

  // --- Reset ---
  reset: () => void;
}

export type ViewerStore = ViewerState & ViewerActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: ViewerState = {
  mainView: "chat",
  activeAppId: null,
  openedAppState: null,
  activeDocumentSurfaceId: null,
  openedDocumentState: null,
  isAppMinimized: false,
  intelligenceTab: "identity",
  assetsRefreshKey: 0,
  viewBeforeDocument: "chat",
  activeSubagentId: null,
  viewBeforeSubagentDetail: "chat",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useViewerStoreBase = create<ViewerStore>()((set, get) => ({
  ...INITIAL_STATE,

  // --- View navigation ---

  setMainView: (view) => {
    if (get().mainView === view) return;
    set({ mainView: view });
  },

  setIntelligenceTab: (tab) => {
    if (get().intelligenceTab === tab) return;
    set({ intelligenceTab: tab });
  },

  // --- App viewer ---

  openApp: (appId) => {
    set({
      mainView: "app",
      activeAppId: appId,
      openedAppState: null,
      isAppMinimized: false,
    });
  },

  loadApp: async (assistantId, appId) => {
    set({
      mainView: "app",
      activeAppId: appId,
      openedAppState: null,
      isAppMinimized: false,
    });
    try {
      const { data: result } = await appsByIdOpenPost({
        path: { assistant_id: assistantId, id: appId },
        throwOnError: true,
      });
      if (get().activeAppId !== appId) return;
      const app = { appId: result.appId, dirName: result.dirName, name: result.name, html: result.html };
      set({ openedAppState: app });
      primeAppHtmlCache(assistantId, result.appId, result.html);
    } catch (err) {
      if (get().activeAppId !== appId) return;
      Sentry.captureException(err, { tags: { context: "openApp" } });
      set({ mainView: "chat", activeAppId: null, openedAppState: null });
    }
  },

  setLoadedApp: (app) => {
    set({ openedAppState: app });
  },

  handleAppLoadFailed: () => {
    set({
      mainView: "chat",
      activeAppId: null,
      openedAppState: null,
    });
  },

  closeApp: () => {
    set({
      activeAppId: null,
      openedAppState: null,
      isAppMinimized: false,
    });
  },

  toggleAppMinimized: () => {
    set({ isAppMinimized: !get().isAppMinimized });
  },

  handleAppUnpinned: (appId) => {
    const state = get();
    if (
      state.activeAppId !== appId ||
      (state.mainView !== "app" && state.mainView !== "app-editing")
    ) {
      return;
    }
    set({
      mainView: "chat",
      activeAppId: null,
      openedAppState: null,
    });
  },

  enterAppEditing: () => {
    set({ mainView: "app-editing" });
  },

  exitAppEditing: () => {
    set({ mainView: "app" });
  },

  // --- Subagent detail ---

  openSubagentDetail: (subagentId) => {
    const state = get();
    const viewBeforeSubagentDetail =
      state.mainView === "subagent-detail" || state.mainView === "document"
        ? state.viewBeforeSubagentDetail
        : (state.mainView as Exclude<MainView, "document" | "subagent-detail">);
    set({
      mainView: "subagent-detail",
      activeSubagentId: subagentId,
      viewBeforeSubagentDetail,
    });
  },

  closeSubagentDetail: () => {
    set({
      mainView: get().viewBeforeSubagentDetail,
      activeSubagentId: null,
    });
  },

  // --- Document viewer ---

  openDocument: () => {
    const state = get();
    const viewBeforeDocument =
      state.mainView === "document" || state.mainView === "subagent-detail"
        ? state.viewBeforeDocument
        : (state.mainView as Exclude<MainView, "document" | "subagent-detail">);
    set({
      mainView: "document",
      openedDocumentState: null,
      viewBeforeDocument,
    });
  },

  loadDocument: async (assistantId, documentSurfaceId) => {
    const state = get();
    const viewBeforeDocument =
      state.mainView === "document" || state.mainView === "subagent-detail"
        ? state.viewBeforeDocument
        : (state.mainView as Exclude<MainView, "document" | "subagent-detail">);
    set({
      mainView: "document",
      activeDocumentSurfaceId: documentSurfaceId,
      openedDocumentState: null,
      viewBeforeDocument,
    });
    try {
      const { data: result } = await documentsByIdGet({
        path: { assistant_id: assistantId, id: documentSurfaceId },
        throwOnError: true,
      });
      if (get().activeDocumentSurfaceId !== documentSurfaceId) return;
      if (!result) {
        set({ mainView: viewBeforeDocument, activeDocumentSurfaceId: null, openedDocumentState: null });
        return;
      }
      set({
        openedDocumentState: {
          surfaceId: result.surfaceId,
          conversationId: result.conversationId,
          documentName: result.title ?? "Untitled",
          content: result.content ?? "",
        },
      });
    } catch {
      if (get().activeDocumentSurfaceId !== documentSurfaceId) return;
      set({ mainView: viewBeforeDocument, activeDocumentSurfaceId: null, openedDocumentState: null });
    }
  },

  setLoadedDocument: (document) => {
    set({ openedDocumentState: document });
  },

  updateDocumentContent: (surfaceId, content, mode) => {
    const state = get();
    if (!state.openedDocumentState || state.openedDocumentState.surfaceId !== surfaceId) return;
    const prev = state.openedDocumentState;
    const newContent = mode === "append" ? prev.content + content : content;
    set({ openedDocumentState: { ...prev, content: newContent } });
  },

  handleDocumentLoadFailed: () => {
    set({
      mainView: get().viewBeforeDocument,
      activeDocumentSurfaceId: null,
      openedDocumentState: null,
    });
  },

  closeDocument: () => {
    set({
      mainView: get().viewBeforeDocument,
      activeDocumentSurfaceId: null,
      openedDocumentState: null,
    });
  },

  // --- Assets ---

  refreshAssets: () => {
    set({ assetsRefreshKey: get().assetsRefreshKey + 1 });
  },

  // --- Reset ---

  /**
   * Restore viewer state to its initial value. Does NOT reset share/deploy
   * state — that lives in `useDeployStore` and has its own `reset()`.
   * Callers that want a full UI reset should call both.
   */
  reset: () => set({ ...INITIAL_STATE }),
}));

export const useViewerStore = createSelectors(useViewerStoreBase);

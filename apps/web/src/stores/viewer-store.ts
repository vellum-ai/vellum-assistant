/**
 * Zustand store for viewer UI state.
 *
 * Manages panel navigation, app/document viewer lifecycle, and
 * share/deploy operations as direct named actions.
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
 * - Share/deploy in-flight state
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

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

export interface ComplexDeployApp {
  appId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ViewerState {
  mainView: MainView;
  activeAppId: string | null;
  openedAppState: OpenedAppState | null;
  openedDocumentState: OpenedDocumentState | null;
  isAppMinimized: boolean;
  intelligenceTab: IntelligenceTab;
  assetsRefreshKey: number;
  viewBeforeDocument: Exclude<MainView, "document" | "subagent-detail">;
  activeSubagentId: string | null;
  viewBeforeSubagentDetail: Exclude<MainView, "document" | "subagent-detail">;
  isSharing: boolean;
  isDeploying: boolean;
  isTokenDialogOpen: boolean;
  pendingDeployAppId: string | null;
  complexDeployApp: ComplexDeployApp | null;
}

export interface ViewerActions {
  // --- View navigation ---
  setMainView: (view: MainView) => void;
  setIntelligenceTab: (tab: IntelligenceTab) => void;

  // --- App viewer ---
  openApp: (appId: string) => void;
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
  setLoadedDocument: (document: OpenedDocumentState) => void;
  handleDocumentLoadFailed: () => void;
  closeDocument: () => void;

  // --- Assets ---
  refreshAssets: () => void;

  // --- Share / Deploy ---
  startSharing: () => void;
  finishSharing: () => void;
  startDeploying: () => void;
  finishDeploying: (clearPendingAppId?: boolean) => void;
  showTokenDialog: (pendingAppId: string) => void;
  hideTokenDialog: () => void;
  setComplexDeployApp: (app: ComplexDeployApp | null) => void;

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
  openedDocumentState: null,
  isAppMinimized: false,
  intelligenceTab: "identity",
  assetsRefreshKey: 0,
  viewBeforeDocument: "chat",
  activeSubagentId: null,
  viewBeforeSubagentDetail: "chat",
  isSharing: false,
  isDeploying: false,
  isTokenDialogOpen: false,
  pendingDeployAppId: null,
  complexDeployApp: null,
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

  setLoadedDocument: (document) => {
    set({ openedDocumentState: document });
  },

  handleDocumentLoadFailed: () => {
    set({
      mainView: get().viewBeforeDocument,
      openedDocumentState: null,
    });
  },

  closeDocument: () => {
    set({
      mainView: get().viewBeforeDocument,
      openedDocumentState: null,
    });
  },

  // --- Assets ---

  refreshAssets: () => {
    set({ assetsRefreshKey: get().assetsRefreshKey + 1 });
  },

  // --- Share / Deploy ---

  startSharing: () => {
    set({ isSharing: true });
  },

  finishSharing: () => {
    set({ isSharing: false });
  },

  startDeploying: () => {
    set({ isDeploying: true });
  },

  finishDeploying: (clearPendingAppId) => {
    set({
      isDeploying: false,
      ...(clearPendingAppId ? { pendingDeployAppId: null } : {}),
    });
  },

  showTokenDialog: (pendingAppId) => {
    set({
      isTokenDialogOpen: true,
      pendingDeployAppId: pendingAppId,
      isDeploying: false,
    });
  },

  hideTokenDialog: () => {
    set({ isTokenDialogOpen: false });
  },

  setComplexDeployApp: (app) => {
    set({ complexDeployApp: app });
  },

  // --- Reset ---

  reset: () => set({ ...INITIAL_STATE }),
}));

export const useViewerStore = createSelectors(useViewerStoreBase);

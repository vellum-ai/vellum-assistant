/**
 * Viewer-state machine.
 *
 * Manages the panel / app-viewer / document-viewer state as a single
 * `useReducer` with typed domain events. All state transitions go through
 * `viewerReducer`, keeping updates atomic and testable.
 *
 * **State managed:**
 * - `mainView` — which top-level panel is displayed (chat, intelligence, library, app, document)
 * - `activeAppId` — ID of the app currently open in the viewer
 * - `openedAppState` — fetched HTML + metadata for the active app
 * - `openedDocumentState` — fetched content for an open document
 * - `isAppMinimized` — mobile-only: app viewer slides down to a thin strip
 * - `intelligenceTab` — which sub-tab is active inside the intelligence panel
 * - `assetsRefreshKey` — counter bumped to force asset re-fetches
 * - `viewBeforeDocument` — remembers the previous view so "close document" can restore it
 * - `isSharing` — in-flight share-app operation
 * - `isDeploying` — in-flight deploy-to-Vercel operation
 * - `showTokenDialog` — Vercel token dialog open
 * - `pendingDeployAppId` — app awaiting token before deploy resumes
 * - `complexDeployApp` — app that needs confirmation before complex deploy
 *
 * @see https://react.dev/learn/extracting-state-logic-into-a-reducer
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MainView = "chat" | "intelligence" | "library" | "app" | "app-editing" | "document" | "home" | "subagent-detail";

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
// State
// ---------------------------------------------------------------------------

/** All viewer UI state managed by `viewerReducer`. */
export interface ViewerState {
  mainView: MainView;
  activeAppId: string | null;
  openedAppState: OpenedAppState | null;
  openedDocumentState: OpenedDocumentState | null;
  isAppMinimized: boolean;
  intelligenceTab: IntelligenceTab;
  assetsRefreshKey: number;
  viewBeforeDocument: Exclude<MainView, "document">;
  activeSubagentId: string | null;
  viewBeforeSubagentDetail: Exclude<MainView, "subagent-detail">;
  isSharing: boolean;
  isDeploying: boolean;
  showTokenDialog: boolean;
  pendingDeployAppId: string | null;
  complexDeployApp: ComplexDeployApp | null;
}

/** Default initial state — used as the `useReducer` initializer. */
export const INITIAL_VIEWER_STATE: ViewerState = {
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
  showTokenDialog: false,
  pendingDeployAppId: null,
  complexDeployApp: null,
};

// ---------------------------------------------------------------------------
// Domain events (actions)
// ---------------------------------------------------------------------------

// --- View navigation ---

export interface SetMainView {
  type: "SET_MAIN_VIEW";
  view: MainView;
}

export interface SetIntelligenceTab {
  type: "SET_INTELLIGENCE_TAB";
  tab: IntelligenceTab;
}

// --- App viewer ---

/** Begin loading an app — clears previous app state and switches to "app" view. */
export interface OpenAppStart {
  type: "OPEN_APP_START";
  appId: string;
}

/** App HTML fetched successfully. */
export interface AppLoaded {
  type: "APP_LOADED";
  app: OpenedAppState;
}

/** App fetch failed — fall back to chat view. */
export interface AppLoadFailed {
  type: "APP_LOAD_FAILED";
}

/** Close the app viewer and return to chat. */
export interface CloseApp {
  type: "CLOSE_APP";
}

export interface ToggleAppMinimized {
  type: "TOGGLE_APP_MINIMIZED";
}

/** Pinned app was removed — reset if it's the active one. */
export interface ActiveAppUnpinned {
  type: "ACTIVE_APP_UNPINNED";
  appId: string;
}

export interface EnterAppEditing {
  type: "ENTER_APP_EDITING";
}

export interface ExitAppEditing {
  type: "EXIT_APP_EDITING";
}

// --- Subagent detail ---

/** Open the subagent detail panel — saves the current view for restoration. */
export interface OpenSubagentDetail {
  type: "OPEN_SUBAGENT_DETAIL";
  subagentId: string;
}

/** Close the subagent detail panel and restore the previous view. */
export interface CloseSubagentDetail {
  type: "CLOSE_SUBAGENT_DETAIL";
}

// --- Document viewer ---

/** Begin loading a document — saves the current view for restoration. */
export interface OpenDocumentStart {
  type: "OPEN_DOCUMENT_START";
}

export interface DocumentLoaded {
  type: "DOCUMENT_LOADED";
  document: OpenedDocumentState;
}

export interface DocumentLoadFailed {
  type: "DOCUMENT_LOAD_FAILED";
}

export interface CloseDocument {
  type: "CLOSE_DOCUMENT";
}

// --- Assets ---

export interface RefreshAssets {
  type: "REFRESH_ASSETS";
}

// --- Share / Deploy ---

export interface StartSharing {
  type: "START_SHARING";
}

export interface SharingDone {
  type: "SHARING_DONE";
}

export interface StartDeploying {
  type: "START_DEPLOYING";
}

export interface DeployingDone {
  type: "DEPLOYING_DONE";
  clearPendingAppId?: boolean;
}

export interface ShowTokenDialog {
  type: "SHOW_TOKEN_DIALOG";
  pendingAppId: string;
}

export interface HideTokenDialog {
  type: "HIDE_TOKEN_DIALOG";
}

export interface SetComplexDeployApp {
  type: "SET_COMPLEX_DEPLOY_APP";
  app: ComplexDeployApp | null;
}

// --- Union ---

export type ViewerAction =
  | SetMainView
  | SetIntelligenceTab
  | OpenAppStart
  | AppLoaded
  | AppLoadFailed
  | CloseApp
  | ToggleAppMinimized
  | ActiveAppUnpinned
  | EnterAppEditing
  | ExitAppEditing
  | OpenSubagentDetail
  | CloseSubagentDetail
  | OpenDocumentStart
  | DocumentLoaded
  | DocumentLoadFailed
  | CloseDocument
  | RefreshAssets
  | StartSharing
  | SharingDone
  | StartDeploying
  | DeployingDone
  | ShowTokenDialog
  | HideTokenDialog
  | SetComplexDeployApp;

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer for viewer state.
 *
 * Accepts a `ViewerAction` discriminated union and returns the next state.
 * Compound actions like `OPEN_APP_START` and `CLOSE_APP` update multiple
 * fields atomically — this is the primary benefit over scattered `useState`
 * setters where multi-field updates could render intermediate states.
 */
export function viewerReducer(
  state: ViewerState,
  action: ViewerAction,
): ViewerState {
  switch (action.type) {
    // ----- View navigation -----

    case "SET_MAIN_VIEW":
      if (state.mainView === action.view) return state;
      return { ...state, mainView: action.view };

    case "SET_INTELLIGENCE_TAB":
      if (state.intelligenceTab === action.tab) return state;
      return { ...state, intelligenceTab: action.tab };

    // ----- App viewer -----

    case "OPEN_APP_START":
      return {
        ...state,
        mainView: "app",
        activeAppId: action.appId,
        openedAppState: null,
        isAppMinimized: false,
      };

    case "APP_LOADED":
      return { ...state, openedAppState: action.app };

    case "APP_LOAD_FAILED":
      return {
        ...state,
        mainView: "chat",
        activeAppId: null,
        openedAppState: null,
      };

    case "CLOSE_APP":
      return {
        ...state,
        activeAppId: null,
        openedAppState: null,
        isAppMinimized: false,
      };

    case "TOGGLE_APP_MINIMIZED":
      return { ...state, isAppMinimized: !state.isAppMinimized };

    case "ACTIVE_APP_UNPINNED":
      if (
        state.activeAppId !== action.appId ||
        (state.mainView !== "app" && state.mainView !== "app-editing")
      ) {
        return state;
      }
      return {
        ...state,
        mainView: "chat",
        activeAppId: null,
        openedAppState: null,
      };

    case "ENTER_APP_EDITING":
      return { ...state, mainView: "app-editing" };

    case "EXIT_APP_EDITING":
      return { ...state, mainView: "app" };

    // ----- Subagent detail -----

    case "OPEN_SUBAGENT_DETAIL": {
      const viewBeforeSubagentDetail =
        state.mainView === "subagent-detail"
          ? state.viewBeforeSubagentDetail
          : (state.mainView as Exclude<MainView, "subagent-detail">);
      return {
        ...state,
        mainView: "subagent-detail",
        activeSubagentId: action.subagentId,
        viewBeforeSubagentDetail,
      };
    }

    case "CLOSE_SUBAGENT_DETAIL":
      return {
        ...state,
        mainView: state.viewBeforeSubagentDetail,
        activeSubagentId: null,
      };

    // ----- Document viewer -----

    case "OPEN_DOCUMENT_START": {
      const viewBeforeDocument =
        state.mainView === "document"
          ? state.viewBeforeDocument
          : (state.mainView as Exclude<MainView, "document">);
      return {
        ...state,
        mainView: "document",
        openedDocumentState: null,
        viewBeforeDocument,
      };
    }

    case "DOCUMENT_LOADED":
      return { ...state, openedDocumentState: action.document };

    case "DOCUMENT_LOAD_FAILED":
      return {
        ...state,
        mainView: state.viewBeforeDocument,
        openedDocumentState: null,
      };

    case "CLOSE_DOCUMENT":
      return {
        ...state,
        mainView: state.viewBeforeDocument,
        openedDocumentState: null,
      };

    // ----- Assets -----

    case "REFRESH_ASSETS":
      return { ...state, assetsRefreshKey: state.assetsRefreshKey + 1 };

    // ----- Share / Deploy -----

    case "START_SHARING":
      return { ...state, isSharing: true };

    case "SHARING_DONE":
      return { ...state, isSharing: false };

    case "START_DEPLOYING":
      return { ...state, isDeploying: true };

    case "DEPLOYING_DONE":
      return {
        ...state,
        isDeploying: false,
        pendingDeployAppId: action.clearPendingAppId
          ? null
          : state.pendingDeployAppId,
      };

    case "SHOW_TOKEN_DIALOG":
      return {
        ...state,
        showTokenDialog: true,
        pendingDeployAppId: action.pendingAppId,
        isDeploying: false,
      };

    case "HIDE_TOKEN_DIALOG":
      return { ...state, showTokenDialog: false };

    case "SET_COMPLEX_DEPLOY_APP":
      return { ...state, complexDeployApp: action.app };

    default:
      return state;
  }
}

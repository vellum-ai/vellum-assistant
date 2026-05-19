import { describe, it, expect } from "bun:test";

import {
  type ViewerState,
  INITIAL_VIEWER_STATE,
  viewerReducer,
} from "@/stores/viewer-store.js";

function stateWith(overrides: Partial<ViewerState>): ViewerState {
  return { ...INITIAL_VIEWER_STATE, ...overrides };
}

const SAMPLE_APP = { appId: "app-1", dirName: "my-app", name: "My App", html: "<h1>App</h1>" };
const SAMPLE_DOC = { surfaceId: "surf-1", conversationId: "conv-1", documentName: "README.md", content: "# Hello" };

// ---------------------------------------------------------------------------
// View navigation
// ---------------------------------------------------------------------------

describe("viewerReducer", () => {
  describe("SET_MAIN_VIEW", () => {
    it("switches the main view", () => {
      const next = viewerReducer(INITIAL_VIEWER_STATE, {
        type: "SET_MAIN_VIEW",
        view: "intelligence",
      });
      expect(next.mainView).toBe("intelligence");
    });

    it("returns the same state when view is unchanged", () => {
      const state = stateWith({ mainView: "chat" });
      const next = viewerReducer(state, { type: "SET_MAIN_VIEW", view: "chat" });
      expect(next).toBe(state);
    });
  });

  describe("SET_INTELLIGENCE_TAB", () => {
    it("switches the intelligence tab", () => {
      const next = viewerReducer(INITIAL_VIEWER_STATE, {
        type: "SET_INTELLIGENCE_TAB",
        tab: "skills",
      });
      expect(next.intelligenceTab).toBe("skills");
    });

    it("returns the same state when tab is unchanged", () => {
      const state = stateWith({ intelligenceTab: "identity" });
      const next = viewerReducer(state, {
        type: "SET_INTELLIGENCE_TAB",
        tab: "identity",
      });
      expect(next).toBe(state);
    });
  });

  // ---------------------------------------------------------------------------
  // App viewer
  // ---------------------------------------------------------------------------

  describe("OPEN_APP_START", () => {
    it("sets activeAppId, clears openedAppState, switches to app view, resets minimized", () => {
      const state = stateWith({
        mainView: "chat",
        openedAppState: SAMPLE_APP,
        isAppMinimized: true,
      });
      const next = viewerReducer(state, {
        type: "OPEN_APP_START",
        appId: "app-2",
      });
      expect(next.mainView).toBe("app");
      expect(next.activeAppId).toBe("app-2");
      expect(next.openedAppState).toBeNull();
      expect(next.isAppMinimized).toBe(false);
    });
  });

  describe("APP_LOADED", () => {
    it("sets the opened app state", () => {
      const next = viewerReducer(INITIAL_VIEWER_STATE, {
        type: "APP_LOADED",
        app: SAMPLE_APP,
      });
      expect(next.openedAppState).toBe(SAMPLE_APP);
    });
  });

  describe("APP_LOAD_FAILED", () => {
    it("resets to chat view and clears app state", () => {
      const state = stateWith({
        mainView: "app",
        activeAppId: "app-1",
        openedAppState: SAMPLE_APP,
      });
      const next = viewerReducer(state, { type: "APP_LOAD_FAILED" });
      expect(next.mainView).toBe("chat");
      expect(next.activeAppId).toBeNull();
      expect(next.openedAppState).toBeNull();
    });
  });

  describe("CLOSE_APP", () => {
    it("clears app state and resets minimized", () => {
      const state = stateWith({
        activeAppId: "app-1",
        openedAppState: SAMPLE_APP,
        isAppMinimized: true,
      });
      const next = viewerReducer(state, { type: "CLOSE_APP" });
      expect(next.activeAppId).toBeNull();
      expect(next.openedAppState).toBeNull();
      expect(next.isAppMinimized).toBe(false);
    });

    it("does not change mainView (caller decides)", () => {
      const state = stateWith({ mainView: "app" });
      const next = viewerReducer(state, { type: "CLOSE_APP" });
      expect(next.mainView).toBe("app");
    });
  });

  describe("TOGGLE_APP_MINIMIZED", () => {
    it("toggles from false to true", () => {
      const next = viewerReducer(INITIAL_VIEWER_STATE, { type: "TOGGLE_APP_MINIMIZED" });
      expect(next.isAppMinimized).toBe(true);
    });

    it("toggles from true to false", () => {
      const state = stateWith({ isAppMinimized: true });
      const next = viewerReducer(state, { type: "TOGGLE_APP_MINIMIZED" });
      expect(next.isAppMinimized).toBe(false);
    });
  });

  describe("ACTIVE_APP_UNPINNED", () => {
    it("resets to chat when the pinned app matches the active app in 'app' view", () => {
      const state = stateWith({
        mainView: "app",
        activeAppId: "app-1",
        openedAppState: SAMPLE_APP,
      });
      const next = viewerReducer(state, {
        type: "ACTIVE_APP_UNPINNED",
        appId: "app-1",
      });
      expect(next.mainView).toBe("chat");
      expect(next.activeAppId).toBeNull();
      expect(next.openedAppState).toBeNull();
    });

    it("resets when in app-editing view", () => {
      const state = stateWith({
        mainView: "app-editing",
        activeAppId: "app-1",
      });
      const next = viewerReducer(state, {
        type: "ACTIVE_APP_UNPINNED",
        appId: "app-1",
      });
      expect(next.mainView).toBe("chat");
    });

    it("returns same state when appId does not match", () => {
      const state = stateWith({
        mainView: "app",
        activeAppId: "app-1",
      });
      const next = viewerReducer(state, {
        type: "ACTIVE_APP_UNPINNED",
        appId: "app-2",
      });
      expect(next).toBe(state);
    });

    it("returns same state when not in app or app-editing view", () => {
      const state = stateWith({
        mainView: "chat",
        activeAppId: "app-1",
      });
      const next = viewerReducer(state, {
        type: "ACTIVE_APP_UNPINNED",
        appId: "app-1",
      });
      expect(next).toBe(state);
    });
  });

  describe("ENTER_APP_EDITING", () => {
    it("switches to app-editing view", () => {
      const state = stateWith({ mainView: "app" });
      const next = viewerReducer(state, { type: "ENTER_APP_EDITING" });
      expect(next.mainView).toBe("app-editing");
    });
  });

  describe("EXIT_APP_EDITING", () => {
    it("switches back to app view", () => {
      const state = stateWith({ mainView: "app-editing" });
      const next = viewerReducer(state, { type: "EXIT_APP_EDITING" });
      expect(next.mainView).toBe("app");
    });
  });

  // ---------------------------------------------------------------------------
  // Subagent detail
  // ---------------------------------------------------------------------------

  describe("OPEN_SUBAGENT_DETAIL", () => {
    it("saves current view and switches to subagent-detail", () => {
      const state = stateWith({ mainView: "chat" });
      const next = viewerReducer(state, {
        type: "OPEN_SUBAGENT_DETAIL",
        subagentId: "sa-1",
      });
      expect(next.mainView).toBe("subagent-detail");
      expect(next.activeSubagentId).toBe("sa-1");
      expect(next.viewBeforeSubagentDetail).toBe("chat");
    });

    it("preserves existing viewBeforeSubagentDetail when already in subagent-detail", () => {
      const state = stateWith({
        mainView: "subagent-detail",
        viewBeforeSubagentDetail: "intelligence",
        activeSubagentId: "sa-1",
      });
      const next = viewerReducer(state, {
        type: "OPEN_SUBAGENT_DETAIL",
        subagentId: "sa-2",
      });
      expect(next.viewBeforeSubagentDetail).toBe("intelligence");
      expect(next.activeSubagentId).toBe("sa-2");
    });

    it("saves non-chat view correctly", () => {
      const state = stateWith({ mainView: "app" });
      const next = viewerReducer(state, {
        type: "OPEN_SUBAGENT_DETAIL",
        subagentId: "sa-1",
      });
      expect(next.viewBeforeSubagentDetail).toBe("app");
    });
  });

  describe("CLOSE_SUBAGENT_DETAIL", () => {
    it("restores viewBeforeSubagentDetail and clears activeSubagentId", () => {
      const state = stateWith({
        mainView: "subagent-detail",
        viewBeforeSubagentDetail: "chat",
        activeSubagentId: "sa-1",
      });
      const next = viewerReducer(state, { type: "CLOSE_SUBAGENT_DETAIL" });
      expect(next.mainView).toBe("chat");
      expect(next.activeSubagentId).toBeNull();
    });

    it("restores a non-chat view", () => {
      const state = stateWith({
        mainView: "subagent-detail",
        viewBeforeSubagentDetail: "library",
        activeSubagentId: "sa-1",
      });
      const next = viewerReducer(state, { type: "CLOSE_SUBAGENT_DETAIL" });
      expect(next.mainView).toBe("library");
      expect(next.activeSubagentId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Document viewer
  // ---------------------------------------------------------------------------

  describe("OPEN_DOCUMENT_START", () => {
    it("saves current view as viewBeforeDocument and switches to document", () => {
      const state = stateWith({ mainView: "intelligence" });
      const next = viewerReducer(state, { type: "OPEN_DOCUMENT_START" });
      expect(next.mainView).toBe("document");
      expect(next.viewBeforeDocument).toBe("intelligence");
      expect(next.openedDocumentState).toBeNull();
    });

    it("preserves existing viewBeforeDocument when already in document view", () => {
      const state = stateWith({
        mainView: "document",
        viewBeforeDocument: "library",
      });
      const next = viewerReducer(state, { type: "OPEN_DOCUMENT_START" });
      expect(next.viewBeforeDocument).toBe("library");
    });
  });

  describe("DOCUMENT_LOADED", () => {
    it("sets the document state", () => {
      const next = viewerReducer(INITIAL_VIEWER_STATE, {
        type: "DOCUMENT_LOADED",
        document: SAMPLE_DOC,
      });
      expect(next.openedDocumentState).toBe(SAMPLE_DOC);
    });
  });

  describe("DOCUMENT_LOAD_FAILED", () => {
    it("restores viewBeforeDocument and clears document state", () => {
      const state = stateWith({
        mainView: "document",
        viewBeforeDocument: "library",
        openedDocumentState: SAMPLE_DOC,
      });
      const next = viewerReducer(state, { type: "DOCUMENT_LOAD_FAILED" });
      expect(next.mainView).toBe("library");
      expect(next.openedDocumentState).toBeNull();
    });
  });

  describe("CLOSE_DOCUMENT", () => {
    it("restores viewBeforeDocument and clears document state", () => {
      const state = stateWith({
        mainView: "document",
        viewBeforeDocument: "app",
        openedDocumentState: SAMPLE_DOC,
      });
      const next = viewerReducer(state, { type: "CLOSE_DOCUMENT" });
      expect(next.mainView).toBe("app");
      expect(next.openedDocumentState).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  describe("REFRESH_ASSETS", () => {
    it("increments the refresh key", () => {
      const state = stateWith({ assetsRefreshKey: 5 });
      const next = viewerReducer(state, { type: "REFRESH_ASSETS" });
      expect(next.assetsRefreshKey).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Share / Deploy
  // ---------------------------------------------------------------------------

  describe("START_SHARING", () => {
    it("sets isSharing to true", () => {
      const next = viewerReducer(INITIAL_VIEWER_STATE, { type: "START_SHARING" });
      expect(next.isSharing).toBe(true);
    });
  });

  describe("SHARING_DONE", () => {
    it("sets isSharing to false", () => {
      const state = stateWith({ isSharing: true });
      const next = viewerReducer(state, { type: "SHARING_DONE" });
      expect(next.isSharing).toBe(false);
    });
  });

  describe("START_DEPLOYING", () => {
    it("sets isDeploying to true", () => {
      const next = viewerReducer(INITIAL_VIEWER_STATE, { type: "START_DEPLOYING" });
      expect(next.isDeploying).toBe(true);
    });
  });

  describe("DEPLOYING_DONE", () => {
    it("sets isDeploying to false and keeps pendingDeployAppId by default", () => {
      const state = stateWith({ isDeploying: true, pendingDeployAppId: "app-1" });
      const next = viewerReducer(state, { type: "DEPLOYING_DONE" });
      expect(next.isDeploying).toBe(false);
      expect(next.pendingDeployAppId).toBe("app-1");
    });

    it("clears pendingDeployAppId when clearPendingAppId is true", () => {
      const state = stateWith({ isDeploying: true, pendingDeployAppId: "app-1" });
      const next = viewerReducer(state, {
        type: "DEPLOYING_DONE",
        clearPendingAppId: true,
      });
      expect(next.isDeploying).toBe(false);
      expect(next.pendingDeployAppId).toBeNull();
    });
  });

  describe("SHOW_TOKEN_DIALOG", () => {
    it("opens dialog, sets pending app, and stops deploying", () => {
      const state = stateWith({ isDeploying: true });
      const next = viewerReducer(state, {
        type: "SHOW_TOKEN_DIALOG",
        pendingAppId: "app-1",
      });
      expect(next.showTokenDialog).toBe(true);
      expect(next.pendingDeployAppId).toBe("app-1");
      expect(next.isDeploying).toBe(false);
    });
  });

  describe("HIDE_TOKEN_DIALOG", () => {
    it("closes the dialog", () => {
      const state = stateWith({ showTokenDialog: true });
      const next = viewerReducer(state, { type: "HIDE_TOKEN_DIALOG" });
      expect(next.showTokenDialog).toBe(false);
    });
  });

  describe("SET_COMPLEX_DEPLOY_APP", () => {
    it("sets the complex deploy app", () => {
      const app = { appId: "app-1", name: "My App" };
      const next = viewerReducer(INITIAL_VIEWER_STATE, {
        type: "SET_COMPLEX_DEPLOY_APP",
        app,
      });
      expect(next.complexDeployApp).toBe(app);
    });

    it("clears the complex deploy app when null", () => {
      const state = stateWith({ complexDeployApp: { appId: "app-1", name: "My App" } });
      const next = viewerReducer(state, {
        type: "SET_COMPLEX_DEPLOY_APP",
        app: null,
      });
      expect(next.complexDeployApp).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown action passthrough
  // ---------------------------------------------------------------------------

  it("returns the same state for an unknown action type", () => {
    const state = stateWith({ mainView: "app" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = viewerReducer(state, { type: "UNKNOWN" } as any);
    expect(next).toBe(state);
  });
});

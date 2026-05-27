import { beforeEach, describe, it, expect } from "bun:test";

import { useViewerStore } from "@/stores/viewer-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useViewerStore.getState();
}

beforeEach(() => {
  getState().reset();
});

const SAMPLE_APP = { appId: "app-1", dirName: "my-app", name: "My App", html: "<h1>App</h1>" };
const SAMPLE_DOC = { surfaceId: "surf-1", conversationId: "conv-1", documentName: "README.md", content: "# Hello" };

// ---------------------------------------------------------------------------
// View navigation
// ---------------------------------------------------------------------------

describe("setMainView", () => {
  it("switches the main view", () => {
    getState().setMainView("app");
    expect(getState().mainView).toBe("app");
  });

  it("is a no-op when view is unchanged", () => {
    getState().setMainView("chat");
    expect(getState().mainView).toBe("chat");
  });
});

describe("setIntelligenceTab", () => {
  it("switches the intelligence tab", () => {
    getState().setIntelligenceTab("skills");
    expect(getState().intelligenceTab).toBe("skills");
  });

  it("is a no-op when tab is unchanged", () => {
    getState().setIntelligenceTab("identity");
    expect(getState().intelligenceTab).toBe("identity");
  });
});

// ---------------------------------------------------------------------------
// App viewer
// ---------------------------------------------------------------------------

describe("openApp", () => {
  it("sets activeAppId, clears openedAppState, switches to app view, resets minimized", () => {
    useViewerStore.setState({ openedAppState: SAMPLE_APP, isAppMinimized: true });
    getState().openApp("app-2");
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.activeAppId).toBe("app-2");
    expect(state.openedAppState).toBeNull();
    expect(state.isAppMinimized).toBe(false);
  });
});

describe("setLoadedApp", () => {
  it("sets the opened app state", () => {
    getState().setLoadedApp(SAMPLE_APP);
    expect(getState().openedAppState).toBe(SAMPLE_APP);
  });
});

describe("handleAppLoadFailed", () => {
  it("resets to chat view and clears app state", () => {
    useViewerStore.setState({ mainView: "app", activeAppId: "app-1", openedAppState: SAMPLE_APP });
    getState().handleAppLoadFailed();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
  });
});

describe("closeApp", () => {
  it("clears app state and resets minimized", () => {
    useViewerStore.setState({ activeAppId: "app-1", openedAppState: SAMPLE_APP, isAppMinimized: true });
    getState().closeApp();
    const state = getState();
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
    expect(state.isAppMinimized).toBe(false);
  });

  it("does not change mainView (caller decides)", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().closeApp();
    expect(getState().mainView).toBe("app");
  });
});

describe("toggleAppMinimized", () => {
  it("toggles from false to true", () => {
    getState().toggleAppMinimized();
    expect(getState().isAppMinimized).toBe(true);
  });

  it("toggles from true to false", () => {
    useViewerStore.setState({ isAppMinimized: true });
    getState().toggleAppMinimized();
    expect(getState().isAppMinimized).toBe(false);
  });
});

describe("handleAppUnpinned", () => {
  it("resets to chat when the pinned app matches the active app in 'app' view", () => {
    useViewerStore.setState({ mainView: "app", activeAppId: "app-1", openedAppState: SAMPLE_APP });
    getState().handleAppUnpinned("app-1");
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
  });

  it("resets when in app-editing view", () => {
    useViewerStore.setState({ mainView: "app-editing", activeAppId: "app-1" });
    getState().handleAppUnpinned("app-1");
    expect(getState().mainView).toBe("chat");
  });

  it("is a no-op when appId does not match", () => {
    useViewerStore.setState({ mainView: "app", activeAppId: "app-1" });
    getState().handleAppUnpinned("app-2");
    expect(getState().mainView).toBe("app");
    expect(getState().activeAppId).toBe("app-1");
  });

  it("is a no-op when not in app or app-editing view", () => {
    useViewerStore.setState({ mainView: "chat", activeAppId: "app-1" });
    getState().handleAppUnpinned("app-1");
    expect(getState().mainView).toBe("chat");
    expect(getState().activeAppId).toBe("app-1");
  });
});

describe("enterAppEditing", () => {
  it("switches to app-editing view", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().enterAppEditing();
    expect(getState().mainView).toBe("app-editing");
  });
});

describe("exitAppEditing", () => {
  it("switches back to app view", () => {
    useViewerStore.setState({ mainView: "app-editing" });
    getState().exitAppEditing();
    expect(getState().mainView).toBe("app");
  });
});

// ---------------------------------------------------------------------------
// Subagent detail
// ---------------------------------------------------------------------------

describe("openSubagentDetail", () => {
  it("saves current view and switches to subagent-detail", () => {
    getState().openSubagentDetail("sa-1");
    const state = getState();
    expect(state.mainView).toBe("subagent-detail");
    expect(state.activeSubagentId).toBe("sa-1");
    expect(state.viewBeforeSubagentDetail).toBe("chat");
  });

  it("preserves existing viewBeforeSubagentDetail when already in subagent-detail", () => {
    useViewerStore.setState({
      mainView: "subagent-detail",
      viewBeforeSubagentDetail: "app",
      activeSubagentId: "sa-1",
    });
    getState().openSubagentDetail("sa-2");
    const state = getState();
    expect(state.viewBeforeSubagentDetail).toBe("app");
    expect(state.activeSubagentId).toBe("sa-2");
  });

  it("saves non-chat view correctly", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openSubagentDetail("sa-1");
    expect(getState().viewBeforeSubagentDetail).toBe("app");
  });
});

describe("closeSubagentDetail", () => {
  it("restores viewBeforeSubagentDetail and clears activeSubagentId", () => {
    useViewerStore.setState({
      mainView: "subagent-detail",
      viewBeforeSubagentDetail: "chat",
      activeSubagentId: "sa-1",
    });
    getState().closeSubagentDetail();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeSubagentId).toBeNull();
  });

  it("restores a non-chat view", () => {
    useViewerStore.setState({
      mainView: "subagent-detail",
      viewBeforeSubagentDetail: "app",
      activeSubagentId: "sa-1",
    });
    getState().closeSubagentDetail();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.activeSubagentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Document viewer
// ---------------------------------------------------------------------------

describe("openDocument", () => {
  it("saves current view as viewBeforeDocument and switches to document", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openDocument();
    const state = getState();
    expect(state.mainView).toBe("document");
    expect(state.viewBeforeDocument).toBe("app");
    expect(state.openedDocumentState).toBeNull();
  });

  it("preserves existing viewBeforeDocument when already in document view", () => {
    useViewerStore.setState({
      mainView: "document",
      viewBeforeDocument: "app",
    });
    getState().openDocument();
    expect(getState().viewBeforeDocument).toBe("app");
  });
});

describe("setLoadedDocument", () => {
  it("sets the document state", () => {
    getState().setLoadedDocument(SAMPLE_DOC);
    expect(getState().openedDocumentState).toBe(SAMPLE_DOC);
  });
});

describe("handleDocumentLoadFailed", () => {
  it("restores viewBeforeDocument and clears document state", () => {
    useViewerStore.setState({
      mainView: "document",
      viewBeforeDocument: "app",
      openedDocumentState: SAMPLE_DOC,
    });
    getState().handleDocumentLoadFailed();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.openedDocumentState).toBeNull();
  });
});

describe("closeDocument", () => {
  it("restores viewBeforeDocument and clears document state", () => {
    useViewerStore.setState({
      mainView: "document",
      viewBeforeDocument: "app",
      openedDocumentState: SAMPLE_DOC,
    });
    getState().closeDocument();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.openedDocumentState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

describe("refreshAssets", () => {
  it("increments the refresh key", () => {
    useViewerStore.setState({ assetsRefreshKey: 5 });
    getState().refreshAssets();
    expect(getState().assetsRefreshKey).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("restores all state to defaults", () => {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: "app-1",
      openedAppState: SAMPLE_APP,
    });
    getState().reset();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
  });
});

import { beforeEach, describe, it, expect } from "bun:test";

import {
  isAppNotFoundError,
  useViewerStore,
  type ToolDetailPayload,
} from "@/stores/viewer-store";

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
const SAMPLE_TOOL: ToolDetailPayload = {
  toolCallId: "tc-1",
  toolName: "spawn_subagent",
  title: "Spawning subagent",
  activity: "Spawning a research subagent",
  input: { task: "research" },
  result: "done",
  status: "completed",
};

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
  it("resets to chat view, clears app state, and resets minimized", () => {
    useViewerStore.setState({ mainView: "app", activeAppId: "app-1", openedAppState: SAMPLE_APP, isAppMinimized: true });
    getState().closeApp();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
    expect(state.isAppMinimized).toBe(false);
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
    const didClose = getState().handleAppUnpinned("app-1");
    const state = getState();
    expect(didClose).toBe(true);
    expect(state.mainView).toBe("chat");
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
  });

  it("resets when in app-editing view", () => {
    useViewerStore.setState({ mainView: "app-editing", activeAppId: "app-1" });
    const didClose = getState().handleAppUnpinned("app-1");
    expect(didClose).toBe(true);
    expect(getState().mainView).toBe("chat");
  });

  it("is a no-op when appId does not match", () => {
    useViewerStore.setState({ mainView: "app", activeAppId: "app-1" });
    const didClose = getState().handleAppUnpinned("app-2");
    expect(didClose).toBe(false);
    expect(getState().mainView).toBe("app");
    expect(getState().activeAppId).toBe("app-1");
  });

  it("is a no-op when not in app or app-editing view", () => {
    useViewerStore.setState({ mainView: "chat", activeAppId: "app-1" });
    const didClose = getState().handleAppUnpinned("app-1");
    expect(didClose).toBe(false);
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
// Tool detail
// ---------------------------------------------------------------------------

describe("openToolDetail", () => {
  it("sets the tool-detail view, payload, and records the prior view", () => {
    getState().openToolDetail(SAMPLE_TOOL);
    const state = getState();
    expect(state.mainView).toBe("tool-detail");
    expect(state.activeToolDetail).toBe(SAMPLE_TOOL);
    expect(state.viewBeforeToolDetail).toBe("chat");
  });

  it("records a non-chat prior view (app -> restores to app)", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openToolDetail(SAMPLE_TOOL);
    const state = getState();
    expect(state.viewBeforeToolDetail).toBe("app");
    getState().closeToolDetail();
    expect(getState().mainView).toBe("app");
  });

  it("does not overwrite a real prior view with a transient one when already in subagent-detail", () => {
    useViewerStore.setState({
      mainView: "subagent-detail",
      viewBeforeToolDetail: "app",
    });
    getState().openToolDetail(SAMPLE_TOOL);
    const state = getState();
    expect(state.mainView).toBe("tool-detail");
    expect(state.viewBeforeToolDetail).toBe("app");
  });

  it("preserves existing viewBeforeToolDetail when already in tool-detail", () => {
    useViewerStore.setState({
      mainView: "tool-detail",
      viewBeforeToolDetail: "app",
      activeToolDetail: SAMPLE_TOOL,
    });
    getState().openToolDetail({ ...SAMPLE_TOOL, toolCallId: "tc-2" });
    const state = getState();
    expect(state.viewBeforeToolDetail).toBe("app");
    expect(state.activeToolDetail?.toolCallId).toBe("tc-2");
  });
});

describe("toggleToolDetail", () => {
  it("opens the drawer when closed", () => {
    getState().toggleToolDetail(SAMPLE_TOOL);
    const state = getState();
    expect(state.mainView).toBe("tool-detail");
    expect(state.activeToolDetail).toBe(SAMPLE_TOOL);
  });

  it("closes the drawer when toggled with the SAME tool target", () => {
    getState().openToolDetail(SAMPLE_TOOL);
    getState().toggleToolDetail(SAMPLE_TOOL);
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeToolDetail).toBeNull();
  });

  it("switches to a DIFFERENT tool target instead of closing", () => {
    getState().openToolDetail(SAMPLE_TOOL);
    getState().toggleToolDetail({ ...SAMPLE_TOOL, toolCallId: "tc-2" });
    const state = getState();
    expect(state.mainView).toBe("tool-detail");
    expect(state.activeToolDetail?.toolCallId).toBe("tc-2");
  });

  it("closes the drawer when toggled with the SAME thinking target", () => {
    const thinking: ToolDetailPayload = {
      kind: "thinking",
      toolCallId: "",
      toolName: "",
      title: "Thought process",
      activity: "",
      input: {},
      status: "completed",
      thinkingText: "reasoning",
    };
    getState().openToolDetail(thinking);
    getState().toggleToolDetail(thinking);
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeToolDetail).toBeNull();
  });

  it("switches to a DIFFERENT thinking target instead of closing", () => {
    const thinking: ToolDetailPayload = {
      kind: "thinking",
      toolCallId: "",
      toolName: "",
      title: "Thought process",
      activity: "",
      input: {},
      status: "completed",
      thinkingText: "reasoning A",
    };
    getState().openToolDetail(thinking);
    getState().toggleToolDetail({ ...thinking, thinkingText: "reasoning B" });
    const state = getState();
    expect(state.mainView).toBe("tool-detail");
    expect(state.activeToolDetail?.thinkingText).toBe("reasoning B");
  });
});

describe("closeToolDetail", () => {
  it("restores the prior view and clears the payload", () => {
    useViewerStore.setState({
      mainView: "tool-detail",
      viewBeforeToolDetail: "chat",
      activeToolDetail: SAMPLE_TOOL,
    });
    getState().closeToolDetail();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeToolDetail).toBeNull();
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

describe("isAppNotFoundError", () => {
  // These tests lock in the contract: we match the daemon's `{ error: { code,
  // message } }` envelope shape that `httpError(...)` produces and that
  // HeyAPI's `throwOnError: true` throws verbatim. If a future HeyAPI upgrade
  // wraps errors differently (e.g., on a `.data` property of an Error
  // subclass), the matchers below stay correct for the documented contract
  // — production behavior would silently revert to capturing NOT_FOUND noise
  // in Sentry. The Sentry reopen is the signal to come back here.

  it("matches the daemon's nested envelope shape with the appId-suffixed message", () => {
    expect(
      isAppNotFoundError({
        error: { code: "NOT_FOUND", message: "App not found: abc-123" },
      }),
    ).toBe(true);
  });

  it("matches the bare `App not found` message variant", () => {
    expect(
      isAppNotFoundError({
        error: { code: "NOT_FOUND", message: "App not found" },
      }),
    ).toBe(true);
  });

  it("does NOT match a generic route-mismatch 404 (would silently swallow routing regressions)", () => {
    // The daemon's catch-all returns this for unmatched / version-skewed
    // routes. Those are real telemetry — keep them visible in Sentry.
    expect(
      isAppNotFoundError({
        error: { code: "NOT_FOUND", message: "Not found" },
      }),
    ).toBe(false);
  });

  it("does NOT match a flat top-level shape (the wrong assumption the first revision made)", () => {
    expect(isAppNotFoundError({ code: "NOT_FOUND" })).toBe(false);
  });

  it("does NOT match other error codes in the envelope", () => {
    expect(isAppNotFoundError({ error: { code: "FORBIDDEN" } })).toBe(false);
    expect(isAppNotFoundError({ error: { code: "INTERNAL_ERROR" } })).toBe(
      false,
    );
  });

  it("does NOT match an envelope with no inner object", () => {
    expect(isAppNotFoundError({ error: "NOT_FOUND" })).toBe(false);
    expect(isAppNotFoundError({ error: null })).toBe(false);
    expect(isAppNotFoundError({ error: undefined })).toBe(false);
  });

  it("does NOT match non-object catch values", () => {
    expect(isAppNotFoundError(null)).toBe(false);
    expect(isAppNotFoundError(undefined)).toBe(false);
    expect(isAppNotFoundError("NOT_FOUND")).toBe(false);
    expect(isAppNotFoundError(404)).toBe(false);
  });

  it("does NOT match an Error instance carrying the body on `.data` (would catch a HeyAPI shape change)", () => {
    // If HeyAPI upgrades to wrap the body in an Error subclass with the body
    // on `.data`, the helper would silently stop matching real NOT_FOUNDs.
    // This test pins that current behavior so the regression is obvious if
    // someone changes the helper without updating the docstring's stated
    // assumption.
    const wrapped = new Error("App not found");
    (wrapped as Error & { data?: unknown }).data = {
      error: { code: "NOT_FOUND" },
    };
    expect(isAppNotFoundError(wrapped)).toBe(false);
  });
});

import { beforeEach, describe, it, expect, mock } from "bun:test";

// `revealAppForBuild`/`loadApp` fire `appsByIdOpenPost` to fetch the first
// frame. Mock the daemon SDK so the network call resolves in-process —
// the synchronous view transition (the part under test) lands before the
// resolved fetch settles, and the mock prevents an unhandled rejection.
// Bun's `mock.module` leaks across files, so run this file on its own
// (`bun test src/stores/viewer-store.test.ts`) per apps/web testing notes.
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: () =>
    Promise.resolve({
      data: { appId: "app-1", dirName: "my-app", name: "My App", html: "<h1>App</h1>" },
    }),
  documentsByIdGet: () => Promise.resolve({ data: null }),
}));

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

describe("updateOpenedAppPreview", () => {
  function openSampleApp() {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: SAMPLE_APP.appId,
      openedAppState: { ...SAMPLE_APP },
    });
  }

  it("swaps html and sets status on an ok event for the active app", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>v2</h1>",
      compileStatus: "ok",
      reloadGeneration: 2,
    });
    const app = getState().openedAppState;
    expect(app?.html).toBe("<h1>v2</h1>");
    expect(app?.compileStatus).toBe("ok");
    expect(app?.buildErrors).toBeUndefined();
  });

  it("keeps last-good html on a building event (status only)", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: SAMPLE_APP.html,
      compileStatus: "building",
      reloadGeneration: 2,
    });
    const app = getState().openedAppState;
    expect(app?.html).toBe(SAMPLE_APP.html);
    expect(app?.compileStatus).toBe("building");
  });

  it("keeps last-good html on an error event and records buildErrors", () => {
    openSampleApp();
    // A fresh ok first, then a failed recompile.
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>good</h1>",
      compileStatus: "ok",
      reloadGeneration: 2,
    });
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>good</h1>",
      compileStatus: "error",
      buildErrors: ["TS2322: type error"],
      reloadGeneration: 2,
    });
    const app = getState().openedAppState;
    expect(app?.html).toBe("<h1>good</h1>");
    expect(app?.compileStatus).toBe("error");
    expect(app?.buildErrors).toEqual(["TS2322: type error"]);
  });

  it("tracks building -> ok -> error, swapping html only on ok", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>fresh</h1>",
      compileStatus: "building",
      reloadGeneration: 1,
    });
    expect(getState().openedAppState?.html).toBe(SAMPLE_APP.html);

    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>fresh</h1>",
      compileStatus: "ok",
      reloadGeneration: 2,
    });
    expect(getState().openedAppState?.html).toBe("<h1>fresh</h1>");

    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>fresh</h1>",
      compileStatus: "error",
      buildErrors: ["boom"],
      reloadGeneration: 2,
    });
    expect(getState().openedAppState?.html).toBe("<h1>fresh</h1>");
    expect(getState().openedAppState?.compileStatus).toBe("error");
  });

  it("ignores events for a non-active app", () => {
    openSampleApp();
    getState().updateOpenedAppPreview("other-app", {
      html: "<h1>nope</h1>",
      compileStatus: "ok",
      reloadGeneration: 9,
    });
    const app = getState().openedAppState;
    expect(app?.html).toBe(SAMPLE_APP.html);
    expect(app?.compileStatus).toBeUndefined();
  });

  it("no-ops when no app is open", () => {
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>nope</h1>",
      compileStatus: "ok",
      reloadGeneration: 1,
    });
    expect(getState().openedAppState).toBeNull();
  });

  it("persists reloadGeneration on an ok event", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>v2</h1>",
      compileStatus: "ok",
      reloadGeneration: 5,
    });
    expect(getState().openedAppState?.reloadGeneration).toBe(5);
  });

  it("updates state on an ok event with identical html but a higher reloadGeneration", () => {
    openSampleApp();
    // First ok at generation 1.
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: SAMPLE_APP.html,
      compileStatus: "ok",
      reloadGeneration: 1,
    });
    const first = getState().openedAppState;
    expect(first?.reloadGeneration).toBe(1);

    // A successful recompile to byte-identical html, but a bumped generation:
    // the backend bumps the generation so clients force-swap the iframe, so
    // this must NOT be skipped by the no-op guard.
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: SAMPLE_APP.html,
      compileStatus: "ok",
      reloadGeneration: 2,
    });
    const second = getState().openedAppState;
    expect(second?.html).toBe(SAMPLE_APP.html);
    expect(second?.reloadGeneration).toBe(2);
    // The state object is a fresh reference so subscribers re-render.
    expect(second).not.toBe(first);
  });

  it("no-ops on a truly-identical ok event (same html, generation, and status)", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: SAMPLE_APP.html,
      compileStatus: "ok",
      reloadGeneration: 3,
    });
    const before = getState().openedAppState;
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: SAMPLE_APP.html,
      compileStatus: "ok",
      reloadGeneration: 3,
    });
    // Same reference: no set() fired, so no re-render / iframe churn.
    expect(getState().openedAppState).toBe(before);
  });

  it("does not advance reloadGeneration on building/error (keep-last-good)", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>good</h1>",
      compileStatus: "ok",
      reloadGeneration: 4,
    });
    // A failed recompile carries the daemon's unchanged generation; the stored
    // generation must stay at the last-good value so the iframe is not swapped.
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>good</h1>",
      compileStatus: "error",
      buildErrors: ["boom"],
      reloadGeneration: 4,
    });
    expect(getState().openedAppState?.reloadGeneration).toBe(4);
    expect(getState().openedAppState?.html).toBe("<h1>good</h1>");
  });

  it("drops a stale error from an older overlapping build (generation behind stored ok)", () => {
    openSampleApp();
    // Newer build lands ok at generation 5.
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>new-good</h1>",
      compileStatus: "ok",
      reloadGeneration: 5,
    });
    const after = getState().openedAppState;
    // A SLOW older build (generation 3) fails AFTER the newer ok already
    // landed — it must NOT regress the preview into an error state.
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>stale</h1>",
      compileStatus: "error",
      buildErrors: ["stale boom"],
      reloadGeneration: 3,
    });
    // Same reference: the stale event was dropped, no set() fired.
    expect(getState().openedAppState).toBe(after);
    expect(getState().openedAppState?.compileStatus).toBe("ok");
    expect(getState().openedAppState?.html).toBe("<h1>new-good</h1>");
  });

  it("drops a stale building event from an older overlapping build", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>new-good</h1>",
      compileStatus: "ok",
      reloadGeneration: 5,
    });
    const after = getState().openedAppState;
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>new-good</h1>",
      compileStatus: "building",
      reloadGeneration: 2,
    });
    expect(getState().openedAppState).toBe(after);
    expect(getState().openedAppState?.compileStatus).toBe("ok");
  });

  it("applies a building/error event whose generation equals the stored generation", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>good</h1>",
      compileStatus: "ok",
      reloadGeneration: 5,
    });
    // The terminal event of THIS build carries the same (unchanged) generation
    // — equal is not stale, so it still applies (keep-last-good).
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>good</h1>",
      compileStatus: "error",
      buildErrors: ["boom"],
      reloadGeneration: 5,
    });
    expect(getState().openedAppState?.compileStatus).toBe("error");
    expect(getState().openedAppState?.html).toBe("<h1>good</h1>");
  });

  it("applies an ok event even when its generation is below the stored generation", () => {
    openSampleApp();
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>v5</h1>",
      compileStatus: "ok",
      reloadGeneration: 5,
    });
    // `ok` is never dropped by the stale guard — it carries fresh html. (In
    // practice the daemon's generation is monotonic, but the guard only
    // targets building/error.)
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: "<h1>v3</h1>",
      compileStatus: "ok",
      reloadGeneration: 3,
    });
    expect(getState().openedAppState?.html).toBe("<h1>v3</h1>");
    expect(getState().openedAppState?.reloadGeneration).toBe(3);
  });

  it("does not drop an error when no generation has been stored yet (missing is not stale)", () => {
    openSampleApp();
    // No prior ok — stored generation is undefined. An error event must still
    // surface (matches the prior behavior for first-event error).
    getState().updateOpenedAppPreview(SAMPLE_APP.appId, {
      html: SAMPLE_APP.html,
      compileStatus: "error",
      buildErrors: ["boom"],
      reloadGeneration: 0,
    });
    expect(getState().openedAppState?.compileStatus).toBe("error");
    expect(getState().openedAppState?.buildErrors).toEqual(["boom"]);
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

describe("closeApp build dismissal", () => {
  it("records the closed app as dismissed for the current build", () => {
    useViewerStore.setState({ mainView: "app-editing", activeAppId: "app-1" });
    getState().closeApp();
    expect(getState().dismissedBuildAppId).toBe("app-1");
  });

  it("re-opening an app clears its stale dismissal (openApp/loadApp)", () => {
    useViewerStore.setState({ dismissedBuildAppId: "app-1" });
    getState().openApp("app-1");
    expect(getState().dismissedBuildAppId).toBeNull();
  });
});

describe("clearBuildDismissal", () => {
  it("clears the flag when the appId matches", () => {
    useViewerStore.setState({ dismissedBuildAppId: "app-1" });
    getState().clearBuildDismissal("app-1");
    expect(getState().dismissedBuildAppId).toBeNull();
  });

  it("is a no-op when the appId does not match", () => {
    useViewerStore.setState({ dismissedBuildAppId: "app-1" });
    getState().clearBuildDismissal("app-2");
    expect(getState().dismissedBuildAppId).toBe("app-1");
  });
});

describe("revealAppForBuild", () => {
  it("opens the app-editing split-view and sets activeAppId for a not-open app", () => {
    getState().revealAppForBuild("assistant-1", "app-1");
    const state = getState();
    expect(state.mainView).toBe("app-editing");
    expect(state.activeAppId).toBe("app-1");
    expect(state.isAppMinimized).toBe(false);
  });

  it("does not disrupt an app the user is already viewing (app view)", () => {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: "app-1",
      openedAppState: SAMPLE_APP,
    });
    getState().revealAppForBuild("assistant-1", "app-1");
    const state = getState();
    // Stays in the full-width app view — not yanked into the split.
    expect(state.mainView).toBe("app");
    expect(state.openedAppState).toBe(SAMPLE_APP);
  });

  it("does not disrupt an app the user is already editing (app-editing view)", () => {
    useViewerStore.setState({
      mainView: "app-editing",
      activeAppId: "app-1",
      openedAppState: SAMPLE_APP,
    });
    getState().revealAppForBuild("assistant-1", "app-1");
    expect(getState().mainView).toBe("app-editing");
    expect(getState().openedAppState).toBe(SAMPLE_APP);
  });

  it("does not re-open an app the user dismissed during the current build", () => {
    useViewerStore.setState({ mainView: "chat", dismissedBuildAppId: "app-1" });
    getState().revealAppForBuild("assistant-1", "app-1");
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeAppId).toBeNull();
  });

  it("opens despite a dismissal recorded for a DIFFERENT app", () => {
    useViewerStore.setState({ mainView: "chat", dismissedBuildAppId: "app-2" });
    getState().revealAppForBuild("assistant-1", "app-1");
    expect(getState().mainView).toBe("app-editing");
    expect(getState().activeAppId).toBe("app-1");
    // The other app's dismissal is untouched.
    expect(getState().dismissedBuildAppId).toBe("app-2");
  });

  it("seeds openedAppState with the build event's last-good html", () => {
    getState().revealAppForBuild("assistant-1", "app-1", {
      html: "<h1>Last good</h1>",
      compileStatus: "building",
      reloadGeneration: 3,
    });
    const state = getState();
    expect(state.mainView).toBe("app-editing");
    // Seeded synchronously, before the (racing) fetch settles.
    expect(state.openedAppState?.html).toBe("<h1>Last good</h1>");
    expect(state.openedAppState?.compileStatus).toBe("building");
    expect(state.openedAppState?.reloadGeneration).toBe(3);
  });

  it("keeps the seeded html after the racing fetch settles", async () => {
    getState().revealAppForBuild("assistant-1", "app-1", {
      html: "<h1>Last good</h1>",
      compileStatus: "building",
      reloadGeneration: 3,
    });
    // Let the fire-and-forget fetch resolve. The mock returns the
    // post-rm placeholder html; the seeded last-good html must win, while
    // the fetched metadata (name/dirName) is adopted.
    await Promise.resolve();
    await Promise.resolve();
    const state = getState();
    expect(state.openedAppState?.html).toBe("<h1>Last good</h1>");
    expect(state.openedAppState?.name).toBe("My App");
    expect(state.openedAppState?.dirName).toBe("my-app");
  });

  it("adopts the fetched html when no seed is provided", async () => {
    getState().revealAppForBuild("assistant-1", "app-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(getState().openedAppState?.html).toBe("<h1>App</h1>");
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

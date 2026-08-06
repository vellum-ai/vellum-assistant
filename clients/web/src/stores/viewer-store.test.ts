import { beforeEach, describe, it, expect, mock } from "bun:test";

import type {
  ActivityStepsPayload,
  MessageFilesPayload,
  ToolDetailPayload,
} from "@/stores/viewer-store";
import type {
  DocumentsByIdGetResponse,
  DocumentsForworkspacefilePostResponse,
} from "@/generated/daemon/types.gen";
import { ApiError } from "@/utils/api-errors";
import { makeDisplayAttachment } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";

// The store opens file-backed documents through the daemon SDK. Spread the
// real module so the actions this file does not exercise keep their real
// bindings.
const daemonSdk = await import("@/generated/daemon/sdk.gen");

type FileDocumentResult = {
  data: DocumentsForworkspacefilePostResponse | null;
};

type DocumentResult = {
  data: DocumentsByIdGetResponse | null;
};

let fileDocumentResult: () => Promise<FileDocumentResult> = () =>
  Promise.reject(new Error("not stubbed"));
const fileDocumentCalls: unknown[] = [];

let documentResult: () => Promise<DocumentResult> = () =>
  Promise.reject(new Error("not stubbed"));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsByIdGet: () => documentResult(),
  documentsForworkspacefilePost: (options: unknown) => {
    fileDocumentCalls.push(options);
    return fileDocumentResult();
  },
}));

// The route-missing fallback navigates to the workspace browser, which pulls
// the whole route tree in at call time.
const openWorkspaceFile = mock(async (_path: string) => {});
mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));

const toastError = mock((_message: string) => {});
const toastModule = await import("@vellumai/design-library/components/toast");
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: { ...toastModule.toast, error: toastError },
}));

const { isAppNotFoundError, useViewerStore } = await import(
  "@/stores/viewer-store"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useViewerStore.getState();
}

/** The surface ids a conversation currently holds unseen changes for. */
function unseenFor(conversationId: string): string[] {
  const changed =
    useUnseenDocumentChangesStore.getState().changedDocuments[conversationId];
  return [...(changed ?? [])];
}

beforeEach(() => {
  getState().reset();
  fileDocumentCalls.length = 0;
  toastError.mockClear();
  openWorkspaceFile.mockClear();
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

const SAMPLE_APP = {
  appId: "app-1",
  dirName: "my-app",
  name: "My App",
  html: "<h1>App</h1>",
};
const SAMPLE_DOC = {
  source: "document",
  surfaceId: "surf-1",
  conversationId: "conv-1",
  documentName: "README.md",
  content: "# Hello",
} as const;
const SAMPLE_FILE_DOC = {
  source: "document",
  surfaceId: "surf-file",
  conversationId: "conv-1",
  workspacePath: "drafts/notes.md",
  documentName: "notes.md",
  content: "# Notes",
} as const;
const SAMPLE_FILE_PREVIEW = {
  source: "workspace-file-preview",
  workspacePath: "data/rows.csv",
  documentName: "rows.csv",
  previewKind: "csv",
} as const;
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
    useViewerStore.setState({
      openedAppState: SAMPLE_APP,
      isAppMinimized: true,
    });
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
    useViewerStore.setState({
      mainView: "app",
      activeAppId: "app-1",
      openedAppState: SAMPLE_APP,
    });
    getState().handleAppLoadFailed();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
  });
});

describe("closeApp", () => {
  it("resets to chat view, clears app state, and resets minimized", () => {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: "app-1",
      openedAppState: SAMPLE_APP,
      isAppMinimized: true,
    });
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
    useViewerStore.setState({
      mainView: "app",
      activeAppId: "app-1",
      openedAppState: SAMPLE_APP,
    });
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
// ACP run detail
// ---------------------------------------------------------------------------

describe("openAcpRunDetail", () => {
  it("saves current view and switches to acp-run-detail", () => {
    getState().openAcpRunDetail("acp-1");
    const state = getState();
    expect(state.mainView).toBe("acp-run-detail");
    expect(state.activeAcpRunId).toBe("acp-1");
    expect(state.viewBeforeAcpRunDetail).toBe("chat");
  });

  it("preserves existing viewBeforeAcpRunDetail when already in acp-run-detail", () => {
    useViewerStore.setState({
      mainView: "acp-run-detail",
      viewBeforeAcpRunDetail: "app",
      activeAcpRunId: "acp-1",
    });
    getState().openAcpRunDetail("acp-2");
    const state = getState();
    expect(state.viewBeforeAcpRunDetail).toBe("app");
    expect(state.activeAcpRunId).toBe("acp-2");
  });

  it("saves non-chat view correctly", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openAcpRunDetail("acp-1");
    expect(getState().viewBeforeAcpRunDetail).toBe("app");
  });
});

describe("closeAcpRunDetail", () => {
  it("restores viewBeforeAcpRunDetail and clears activeAcpRunId", () => {
    useViewerStore.setState({
      mainView: "acp-run-detail",
      viewBeforeAcpRunDetail: "chat",
      activeAcpRunId: "acp-1",
    });
    getState().closeAcpRunDetail();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeAcpRunId).toBeNull();
  });

  it("restores a non-chat view", () => {
    useViewerStore.setState({
      mainView: "acp-run-detail",
      viewBeforeAcpRunDetail: "app",
      activeAcpRunId: "acp-1",
    });
    getState().closeAcpRunDetail();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.activeAcpRunId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Background task detail
// ---------------------------------------------------------------------------

describe("openBackgroundTaskDetail", () => {
  it("saves current view and switches to background-task-detail", () => {
    getState().openBackgroundTaskDetail("bg-x");
    const state = getState();
    expect(state.mainView).toBe("background-task-detail");
    expect(state.activeBackgroundTaskId).toBe("bg-x");
    expect(state.viewBeforeBackgroundTaskDetail).toBe("chat");
  });

  it("preserves existing viewBeforeBackgroundTaskDetail when already in background-task-detail", () => {
    useViewerStore.setState({
      mainView: "background-task-detail",
      viewBeforeBackgroundTaskDetail: "app",
      activeBackgroundTaskId: "bg-1",
    });
    getState().openBackgroundTaskDetail("bg-2");
    const state = getState();
    expect(state.viewBeforeBackgroundTaskDetail).toBe("app");
    expect(state.activeBackgroundTaskId).toBe("bg-2");
  });

  it("saves non-chat view correctly", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openBackgroundTaskDetail("bg-1");
    expect(getState().viewBeforeBackgroundTaskDetail).toBe("app");
  });
});

describe("closeBackgroundTaskDetail", () => {
  it("restores viewBeforeBackgroundTaskDetail and clears activeBackgroundTaskId", () => {
    useViewerStore.setState({
      mainView: "background-task-detail",
      viewBeforeBackgroundTaskDetail: "chat",
      activeBackgroundTaskId: "bg-1",
    });
    getState().closeBackgroundTaskDetail();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeBackgroundTaskId).toBeNull();
  });

  it("restores a non-chat view", () => {
    useViewerStore.setState({
      mainView: "background-task-detail",
      viewBeforeBackgroundTaskDetail: "app",
      activeBackgroundTaskId: "bg-1",
    });
    getState().closeBackgroundTaskDetail();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.activeBackgroundTaskId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Skill detail
// ---------------------------------------------------------------------------

describe("openSkillDetail", () => {
  it("saves current view and switches to skill-detail", () => {
    getState().openSkillDetail("skill-1");
    const state = getState();
    expect(state.mainView).toBe("skill-detail");
    expect(state.activeSkillDetailId).toBe("skill-1");
    expect(state.viewBeforeSkillDetail).toBe("chat");
  });

  it("preserves existing viewBeforeSkillDetail when already in skill-detail", () => {
    useViewerStore.setState({
      mainView: "skill-detail",
      viewBeforeSkillDetail: "app",
      activeSkillDetailId: "skill-1",
    });
    getState().openSkillDetail("skill-2");
    const state = getState();
    expect(state.viewBeforeSkillDetail).toBe("app");
    expect(state.activeSkillDetailId).toBe("skill-2");
  });

  it("saves non-chat view correctly", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openSkillDetail("skill-1");
    expect(getState().viewBeforeSkillDetail).toBe("app");
  });

  it("does not overwrite a real prior view with a transient one when opened over tool-detail", () => {
    useViewerStore.setState({
      mainView: "tool-detail",
      viewBeforeSkillDetail: "app",
      activeToolDetail: SAMPLE_TOOL,
    });
    getState().openSkillDetail("skill-1");
    const state = getState();
    expect(state.mainView).toBe("skill-detail");
    expect(state.viewBeforeSkillDetail).toBe("app");
  });
});

describe("closeSkillDetail", () => {
  it("restores viewBeforeSkillDetail and clears activeSkillDetailId", () => {
    useViewerStore.setState({
      mainView: "skill-detail",
      viewBeforeSkillDetail: "chat",
      activeSkillDetailId: "skill-1",
    });
    getState().closeSkillDetail();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeSkillDetailId).toBeNull();
  });

  it("restores a non-chat view", () => {
    useViewerStore.setState({
      mainView: "skill-detail",
      viewBeforeSkillDetail: "app",
      activeSkillDetailId: "skill-1",
    });
    getState().closeSkillDetail();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.activeSkillDetailId).toBeNull();
  });

  it("unwinds stacked panels one layer at a time (skill-detail over tool-detail)", () => {
    // Mirrors the Escape flow: each panel keeps its own viewBefore*, so
    // closing skill-detail restores its saved non-overlay view, and closing
    // tool-detail afterwards restores the view it saved — the stack never
    // dead-ends inside an overlay.
    getState().openToolDetail(SAMPLE_TOOL);
    getState().openSkillDetail("skill-1");
    getState().closeSkillDetail();
    expect(getState().mainView).toBe("chat");
    expect(getState().activeSkillDetailId).toBeNull();
    getState().closeToolDetail();
    expect(getState().mainView).toBe("chat");
  });
});

// ---------------------------------------------------------------------------
// Workflow detail
// ---------------------------------------------------------------------------

describe("openWorkflowDetail", () => {
  it("saves current view and switches to workflow-detail", () => {
    getState().openWorkflowDetail("run-1");
    const state = getState();
    expect(state.mainView).toBe("workflow-detail");
    expect(state.activeWorkflowRunId).toBe("run-1");
    expect(state.viewBeforeWorkflowDetail).toBe("chat");
  });

  it("preserves existing viewBeforeWorkflowDetail when already in workflow-detail", () => {
    useViewerStore.setState({
      mainView: "workflow-detail",
      viewBeforeWorkflowDetail: "app",
      activeWorkflowRunId: "run-1",
    });
    getState().openWorkflowDetail("run-2");
    const state = getState();
    expect(state.viewBeforeWorkflowDetail).toBe("app");
    expect(state.activeWorkflowRunId).toBe("run-2");
  });

  it("saves non-chat view correctly", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openWorkflowDetail("run-1");
    expect(getState().viewBeforeWorkflowDetail).toBe("app");
  });
});

describe("closeWorkflowDetail", () => {
  it("restores viewBeforeWorkflowDetail and clears activeWorkflowRunId", () => {
    useViewerStore.setState({
      mainView: "workflow-detail",
      viewBeforeWorkflowDetail: "chat",
      activeWorkflowRunId: "run-1",
    });
    getState().closeWorkflowDetail();
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeWorkflowRunId).toBeNull();
  });

  it("restores a non-chat view", () => {
    useViewerStore.setState({
      mainView: "workflow-detail",
      viewBeforeWorkflowDetail: "app",
      activeWorkflowRunId: "run-1",
    });
    getState().closeWorkflowDetail();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.activeWorkflowRunId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Process-detail routing facade
// ---------------------------------------------------------------------------

describe("openProcessDetail", () => {
  it("routes 'subagent' to openSubagentDetail", () => {
    getState().openProcessDetail({ kind: "subagent", id: "sa-1" });
    const state = getState();
    expect(state.mainView).toBe("subagent-detail");
    expect(state.activeSubagentId).toBe("sa-1");
  });

  it("routes 'workflow' to openWorkflowDetail", () => {
    getState().openProcessDetail({ kind: "workflow", id: "run-1" });
    const state = getState();
    expect(state.mainView).toBe("workflow-detail");
    expect(state.activeWorkflowRunId).toBe("run-1");
  });

  it("routes 'acp-run' to openAcpRunDetail", () => {
    getState().openProcessDetail({ kind: "acp-run", id: "acp-1" });
    const state = getState();
    expect(state.mainView).toBe("acp-run-detail");
    expect(state.activeAcpRunId).toBe("acp-1");
  });

  it("routes 'background-task' to openBackgroundTaskDetail", () => {
    getState().openProcessDetail({ kind: "background-task", id: "bg-1" });
    const state = getState();
    expect(state.mainView).toBe("background-task-detail");
    expect(state.activeBackgroundTaskId).toBe("bg-1");
  });
});

describe("closeActiveOverlay", () => {
  it("closes a tool detail overlay and restores its prior view", () => {
    getState().openToolDetail(SAMPLE_TOOL);

    expect(getState().closeActiveOverlay()).toBe(true);
    expect(getState().mainView).toBe("chat");
    expect(getState().activeToolDetail).toBeNull();
  });

  it("closes a process detail overlay through its specific action", () => {
    getState().openProcessDetail({ kind: "workflow", id: "run-1" });

    expect(getState().closeActiveOverlay()).toBe(true);
    expect(getState().mainView).toBe("chat");
    expect(getState().activeWorkflowRunId).toBeNull();
  });

  it("closes the message-files overlay and restores its prior view", () => {
    getState().openMessageFiles({ messageId: "m1", attachments: [] });

    expect(getState().closeActiveOverlay()).toBe(true);
    expect(getState().mainView).toBe("chat");
    expect(getState().activeMessageFiles).toBeNull();
  });

  it("returns false without changing a non-overlay view", () => {
    useViewerStore.setState({ mainView: "app", activeAppId: "app-1" });

    expect(getState().closeActiveOverlay()).toBe(false);
    expect(getState().mainView).toBe("app");
    expect(getState().activeAppId).toBe("app-1");
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

  it("does not overwrite a real prior view with a transient one when already in workflow-detail", () => {
    useViewerStore.setState({
      mainView: "workflow-detail",
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
// Activity steps panel
// ---------------------------------------------------------------------------

const SAMPLE_STEPS: ActivityStepsPayload = {
  messageId: "m1",
  groupIndex: 0,
  items: [],
  toolCalls: [],
};

describe("openActivitySteps / toggleActivitySteps / closeActivitySteps", () => {
  it("opens the panel with the payload and records the prior view", () => {
    getState().openActivitySteps(SAMPLE_STEPS);
    const state = getState();
    expect(state.mainView).toBe("activity-steps");
    expect(state.activeActivitySteps).toBe(SAMPLE_STEPS);
    expect(state.viewBeforeActivitySteps).toBe("chat");
  });

  it("toggle closes the panel when targeting the SAME (message, group)", () => {
    getState().openActivitySteps(SAMPLE_STEPS);
    getState().toggleActivitySteps({ ...SAMPLE_STEPS });
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeActivitySteps).toBeNull();
  });

  it("toggle switches to a DIFFERENT group instead of closing", () => {
    getState().openActivitySteps(SAMPLE_STEPS);
    getState().toggleActivitySteps({ ...SAMPLE_STEPS, groupIndex: 2 });
    const state = getState();
    expect(state.mainView).toBe("activity-steps");
    expect(state.activeActivitySteps?.groupIndex).toBe(2);
  });

  it("identity-less payloads match on the first tool-call id", () => {
    const a: ActivityStepsPayload = {
      items: [],
      toolCalls: [{ id: "tc-1", name: "bash", input: {} }],
    };
    getState().openActivitySteps(a);
    getState().toggleActivitySteps({
      items: [],
      toolCalls: [{ id: "tc-1", name: "bash", input: {} }],
    });
    expect(getState().mainView).toBe("chat");
  });

  it("close restores a non-chat prior view", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openActivitySteps(SAMPLE_STEPS);
    expect(getState().viewBeforeActivitySteps).toBe("app");
    getState().closeActivitySteps();
    expect(getState().mainView).toBe("app");
  });
});

// ---------------------------------------------------------------------------
// Message files panel
// ---------------------------------------------------------------------------

const SAMPLE_FILES: MessageFilesPayload = {
  messageId: "m1",
  attachments: [
    makeDisplayAttachment({ id: "a1" }),
    makeDisplayAttachment({ id: "a2" }),
  ],
  assistantId: "asst-1",
};

describe("openMessageFiles / toggleMessageFiles / closeMessageFiles", () => {
  it("opens the panel with the payload and records the prior view", () => {
    getState().openMessageFiles(SAMPLE_FILES);
    const state = getState();
    expect(state.mainView).toBe("message-files");
    expect(state.activeMessageFiles).toBe(SAMPLE_FILES);
    expect(state.viewBeforeMessageFiles).toBe("chat");
  });

  it("close restores the prior view and clears the payload", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openMessageFiles(SAMPLE_FILES);
    expect(getState().viewBeforeMessageFiles).toBe("app");
    getState().closeMessageFiles();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.activeMessageFiles).toBeNull();
  });

  it("toggle closes the panel when targeting the SAME message", () => {
    getState().openMessageFiles(SAMPLE_FILES);
    getState().toggleMessageFiles({ ...SAMPLE_FILES });
    const state = getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeMessageFiles).toBeNull();
  });

  it("toggle switches to a DIFFERENT message instead of closing", () => {
    getState().openMessageFiles(SAMPLE_FILES);
    getState().toggleMessageFiles({ ...SAMPLE_FILES, messageId: "m2" });
    const state = getState();
    expect(state.mainView).toBe("message-files");
    expect(state.activeMessageFiles?.messageId).toBe("m2");
  });

  it("clears the transcript panel payloads without touching mainView", () => {
    useViewerStore.setState({ mainView: "app" });
    getState().openMessageFiles(SAMPLE_FILES);
    getState().clearTranscriptPanelPayloads();
    const state = getState();
    expect(state.activeMessageFiles).toBeNull();
    expect(state.activeActivitySteps).toBeNull();
    expect(state.activeToolDetail).toBeNull();
    expect(state.mainView).toBe("message-files");
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
    expect(state.activeDocumentTarget).toBeNull();
  });
});

describe("updateDocumentContent", () => {
  it("applies a streamed replace to the matching document surface", () => {
    useViewerStore.setState({ openedDocumentState: SAMPLE_DOC });
    getState().updateDocumentContent("surf-1", "# Replaced", "replace");
    expect(getState().openedDocumentState).toMatchObject({
      content: "# Replaced",
    });
  });

  it("leaves a document with a different surface id alone", () => {
    useViewerStore.setState({ openedDocumentState: SAMPLE_FILE_DOC });
    getState().updateDocumentContent("surf-1", "# Replaced", "replace");
    expect(getState().openedDocumentState).toBe(SAMPLE_FILE_DOC);
  });

  it("leaves a read-only preview alone", () => {
    useViewerStore.setState({ openedDocumentState: SAMPLE_FILE_PREVIEW });
    getState().updateDocumentContent("surf-1", "# Replaced", "replace");
    expect(getState().openedDocumentState).toBe(SAMPLE_FILE_PREVIEW);
  });
});

// ---------------------------------------------------------------------------
// Document viewer: read-only file previews
// ---------------------------------------------------------------------------

describe("openWorkspaceFilePreview", () => {
  it("shows the file read-only, named by its basename", () => {
    getState().openWorkspaceFilePreview("data/reports/rows.csv", "csv");

    const state = getState();
    expect(state.mainView).toBe("document");
    expect(state.openedDocumentState).toEqual({
      source: "workspace-file-preview",
      workspacePath: "data/reports/rows.csv",
      documentName: "rows.csv",
      previewKind: "csv",
    });
    expect(state.activeDocumentTarget).toEqual({
      source: "workspace-file-preview",
      workspacePath: "data/reports/rows.csv",
    });
  });

  it("saves the prior view so closing restores it", () => {
    useViewerStore.setState({ mainView: "app" });

    getState().openWorkspaceFilePreview("rows.csv", "csv");
    expect(getState().viewBeforeDocument).toBe("app");

    getState().closeDocument();
    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.openedDocumentState).toBeNull();
    expect(state.activeDocumentTarget).toBeNull();
  });

  it("keeps the prior view when swapping one preview for another", () => {
    useViewerStore.setState({ mainView: "app" });

    getState().openWorkspaceFilePreview("rows.csv", "csv");
    getState().openWorkspaceFilePreview("run.log", "text");

    const state = getState();
    expect(state.viewBeforeDocument).toBe("app");
    expect(state.openedDocumentState).toMatchObject({
      workspacePath: "run.log",
      previewKind: "text",
    });
  });

  it("makes an in-flight file load for the same path stale", async () => {
    let resolveLoad: (value: FileDocumentResult) => void = () => {};
    fileDocumentResult = () =>
      new Promise<FileDocumentResult>((resolve) => {
        resolveLoad = resolve;
      });

    const load = getState().loadWorkspaceFileDocument(
      "asst-1",
      "rows.csv",
      "conv-1",
    );
    // The same path, but opened as a preview: a different target.
    getState().openWorkspaceFilePreview("rows.csv", "csv");

    resolveLoad({ data: fileDocument({ workspacePath: "rows.csv" }) });
    await load;

    expect(getState().openedDocumentState).toMatchObject({
      source: "workspace-file-preview",
    });
  });
});

// ---------------------------------------------------------------------------
// Document viewer: document surfaces
// ---------------------------------------------------------------------------

/** The daemon's answer for a document surface fetched by id. */
function documentSurface(
  overrides: Partial<DocumentsByIdGetResponse> = {},
): DocumentsByIdGetResponse {
  return {
    success: true,
    surfaceId: "surf-1",
    conversationId: "conv-1",
    title: "Notes",
    content: "# Notes",
    wordCount: 2,
    createdAt: 1,
    updatedAt: 2,
    workspacePath: null,
    ...overrides,
  };
}

describe("loadDocument", () => {
  it("clears the unseen change for the document it opened", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-1");
    documentResult = () => Promise.resolve({ data: documentSurface() });

    await getState().loadDocument("asst-1", "surf-1");

    expect(getState().mainView).toBe("document");
    expect(unseenFor("conv-1")).toEqual([]);
  });

  it("leaves the conversation's other unseen documents alone", async () => {
    const unseen = useUnseenDocumentChangesStore.getState();
    unseen.markDocumentChanged("conv-1", "surf-1");
    unseen.markDocumentChanged("conv-1", "surf-2");
    documentResult = () => Promise.resolve({ data: documentSurface() });

    await getState().loadDocument("asst-1", "surf-1");

    expect(unseenFor("conv-1")).toEqual(["surf-2"]);
  });

  it("clears a change recorded against a conversation other than the document's", async () => {
    // The daemon records the edit against the conversation the tool ran in,
    // while the document row keeps the conversation that created it.
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-2", "surf-1");
    documentResult = () =>
      Promise.resolve({ data: documentSurface({ conversationId: "conv-1" }) });

    await getState().loadDocument("asst-1", "surf-1");

    expect(unseenFor("conv-2")).toEqual([]);
  });

  it("keeps the unseen change when the open fails", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-1");
    documentResult = () => Promise.reject(new ApiError(404, "Not found"));

    await getState().loadDocument("asst-1", "surf-1");

    expect(unseenFor("conv-1")).toEqual(["surf-1"]);
  });
});

// ---------------------------------------------------------------------------
// Document viewer: workspace files
// ---------------------------------------------------------------------------

/** The daemon's answer for the document bound to a workspace markdown file. */
function fileDocument(
  overrides: Partial<DocumentsForworkspacefilePostResponse> = {},
): DocumentsForworkspacefilePostResponse {
  return {
    success: true,
    surfaceId: "surf-file",
    conversationId: "conv-1",
    title: "notes.md",
    content: "# Notes",
    wordCount: 2,
    createdAt: 1,
    updatedAt: 2,
    workspacePath: "drafts/notes.md",
    ...overrides,
  };
}

describe("loadWorkspaceFileDocument", () => {
  it("opens the file's document as a full document surface", async () => {
    fileDocumentResult = () => Promise.resolve({ data: fileDocument() });

    await getState().loadWorkspaceFileDocument(
      "asst-1",
      "drafts/notes.md",
      "conv-1",
    );

    const state = getState();
    expect(state.mainView).toBe("document");
    expect(state.openedDocumentState).toEqual({
      source: "document",
      surfaceId: "surf-file",
      conversationId: "conv-1",
      documentName: "notes.md",
      content: "# Notes",
      workspacePath: "drafts/notes.md",
    });
    // The surface id exists once the daemon has answered, so the in-flight
    // path target gives way to the document target.
    expect(state.activeDocumentTarget).toEqual({
      source: "document",
      surfaceId: "surf-file",
    });
    expect(fileDocumentCalls.length).toBe(1);
    expect(fileDocumentCalls[0]).toMatchObject({
      path: { assistant_id: "asst-1" },
      body: { path: "drafts/notes.md", conversationId: "conv-1" },
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("clears the unseen change for the document it opened", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-file");
    fileDocumentResult = () => Promise.resolve({ data: fileDocument() });

    await getState().loadWorkspaceFileDocument(
      "asst-1",
      "drafts/notes.md",
      "conv-1",
    );

    expect(unseenFor("conv-1")).toEqual([]);
  });

  it("clears a change recorded against a conversation other than the document's", async () => {
    // Opening the file from another conversation still answers with the
    // conversation that created the document.
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-2", "surf-file");
    fileDocumentResult = () =>
      Promise.resolve({ data: fileDocument({ conversationId: "conv-1" }) });

    await getState().loadWorkspaceFileDocument(
      "asst-1",
      "drafts/notes.md",
      "conv-2",
    );

    expect(unseenFor("conv-2")).toEqual([]);
  });

  it("names an untitled document rather than showing an empty navbar", async () => {
    fileDocumentResult = () =>
      Promise.resolve({ data: fileDocument({ title: "" }) });

    await getState().loadWorkspaceFileDocument(
      "asst-1",
      "drafts/notes.md",
      "conv-1",
    );

    expect(getState().openedDocumentState).toMatchObject({
      documentName: "Untitled",
    });
  });

  it("saves the prior view so closing restores it", async () => {
    useViewerStore.setState({ mainView: "app" });
    fileDocumentResult = () => Promise.resolve({ data: fileDocument() });

    await getState().loadWorkspaceFileDocument("asst-1", "notes.md", "conv-1");
    expect(getState().viewBeforeDocument).toBe("app");

    getState().closeDocument();
    expect(getState().mainView).toBe("app");
  });

  it("repeats the daemon's own message when it refuses the open", async () => {
    useViewerStore.setState({ mainView: "app" });
    fileDocumentResult = () =>
      Promise.reject(
        new ApiError(
          404,
          "The file backing this document no longer exists: gone.md",
        ),
      );

    await getState().loadWorkspaceFileDocument("asst-1", "gone.md", "conv-1");

    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.openedDocumentState).toBeNull();
    expect(state.activeDocumentTarget).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(
      "The file backing this document no longer exists: gone.md",
    );
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  it("keeps the toast for the route's own 404 about a missing file", async () => {
    fileDocumentResult = () =>
      Promise.reject(new ApiError(404, "File not found"));

    await getState().loadWorkspaceFileDocument("asst-1", "gone.md", "conv-1");

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  it("falls back to the workspace browser when the daemon has no such route", async () => {
    useViewerStore.setState({ mainView: "app" });
    // The catch-all an older assistant answers an unknown endpoint with.
    fileDocumentResult = () => Promise.reject(new ApiError(404, "Not found"));

    await getState().loadWorkspaceFileDocument(
      "asst-1",
      "drafts/notes.md",
      "conv-1",
    );

    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.openedDocumentState).toBeNull();
    expect(state.activeDocumentTarget).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("drafts/notes.md");
  });

  it("repeats a rejected file type the same way", async () => {
    fileDocumentResult = () =>
      Promise.reject(new ApiError(422, "Only markdown files open here."));

    await getState().loadWorkspaceFileDocument("asst-1", "rows.csv", "conv-1");

    expect(getState().openedDocumentState).toBeNull();
    expect(toastError.mock.calls[0]![0]).toBe("Only markdown files open here.");
  });

  it("keeps plumbing out of the toast when the request never landed", async () => {
    fileDocumentResult = () => Promise.reject(new TypeError("Failed to fetch"));

    await getState().loadWorkspaceFileDocument("asst-1", "notes.md", "conv-1");

    expect(getState().openedDocumentState).toBeNull();
    expect(toastError.mock.calls[0]![0]).toBe("Couldn't open this file");
  });

  it("does the same for a server fault, which has no message to repeat", async () => {
    fileDocumentResult = () => Promise.reject(new ApiError(500, "HTTP 500"));

    await getState().loadWorkspaceFileDocument("asst-1", "notes.md", "conv-1");

    expect(toastError.mock.calls[0]![0]).toBe("Couldn't open this file");
  });

  it("treats an empty response as a failed open", async () => {
    useViewerStore.setState({ mainView: "app" });
    fileDocumentResult = () => Promise.resolve({ data: null });

    await getState().loadWorkspaceFileDocument("asst-1", "notes.md", "conv-1");

    const state = getState();
    expect(state.mainView).toBe("app");
    expect(state.openedDocumentState).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("ignores a response for a file the user already navigated away from", async () => {
    let resolveFirst: (value: FileDocumentResult) => void = () => {};
    fileDocumentResult = () =>
      new Promise<FileDocumentResult>((resolve) => {
        resolveFirst = resolve;
      });

    const first = getState().loadWorkspaceFileDocument(
      "asst-1",
      "slow.md",
      "conv-1",
    );
    // The user opened a document surface while the file was still loading.
    useViewerStore.setState({
      openedDocumentState: SAMPLE_DOC,
      activeDocumentTarget: { source: "document", surfaceId: "surf-1" },
    });

    resolveFirst({ data: fileDocument({ workspacePath: "slow.md" }) });
    await first;

    expect(getState().openedDocumentState).toBe(SAMPLE_DOC);
    expect(toastError).not.toHaveBeenCalled();
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

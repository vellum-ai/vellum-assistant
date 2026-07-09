/**
 * Chat content layout — routes the active `mainView` to the appropriate
 * panel arrangement.
 *
 * Single responsibility: reads `mainView` from the viewer store, renders
 * `ChatMainPanel` inside the correct layout shell (standalone, or
 * as the left pane of a `ResizablePanel` with a side panel on the right).
 *
 * Side-panel state (app, document, subagent, tool-detail) is read directly
 * from stores — no props required for layout decisions.
 */

import { lazy, useCallback, useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { ResizablePanel } from "@vellumai/design-library";
import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";
import { LazyBoundary } from "@/components/lazy-boundary";
import { AppViewerContainer } from "@/components/app-viewer-container";
import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container";
import { ChatMainPanel, type ChatMainPanelProps } from "@/domains/chat/components/chat-route-content";
import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { ChannelSetupPanel } from "@/domains/chat/components/channel-setup-panel";
import { notifyChannelSetupHandedOff } from "@/domains/chat/channel-setup-close-notify";
import { useEditApp } from "@/hooks/use-edit-app";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

// Import thunks for the lazy panel chunks, shared by the React.lazy wrappers
// below and the idle-prefetch effect. Once a thunk has run, the browser module
// cache lets React.lazy resolve it synchronously.
const importSubagentDetailPanel = () =>
  import("@/domains/chat/components/subagent-detail-panel");
const importToolDetailPanel = () =>
  import("@/domains/chat/components/tool-detail-panel");
const importActivityStepsPanel = () =>
  import("@/domains/chat/components/activity-steps-panel");
const importAcpRunDetailPanel = () =>
  import("@/domains/chat/components/acp-run-detail-panel/acp-run-detail-panel");
const importWorkflowDetailPanel = () =>
  import("@/domains/chat/components/workflow-detail-panel");
const importBackgroundTaskDetailPanel = () =>
  import(
    "@/domains/chat/components/background-task-detail-panel/background-task-detail-panel"
  );
const importSkillDetailPanel = () =>
  import("@/domains/chat/components/skill-detail-panel");

const SubagentDetailPanel = lazy(() =>
  importSubagentDetailPanel().then((m) => ({ default: m.SubagentDetailPanel })),
);
const AcpRunDetailPanel = lazy(() =>
  importAcpRunDetailPanel().then((m) => ({ default: m.AcpRunDetailPanel })),
);
const WorkflowDetailPanel = lazy(() =>
  importWorkflowDetailPanel().then((m) => ({ default: m.WorkflowDetailPanel })),
);
const ToolDetailPanel = lazy(() =>
  importToolDetailPanel().then((m) => ({ default: m.ToolDetailPanel })),
);
const ActivityStepsPanel = lazy(() =>
  importActivityStepsPanel().then((m) => ({ default: m.ActivityStepsPanel })),
);
const BackgroundTaskDetailPanel = lazy(() =>
  importBackgroundTaskDetailPanel().then((m) => ({
    default: m.BackgroundTaskDetailPanel,
  })),
);
const SkillDetailPanel = lazy(() =>
  importSkillDetailPanel().then((m) => ({ default: m.SkillDetailPanel })),
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatContentLayout(props: ChatMainPanelProps) {
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();
  const openedDocumentState = useViewerStore.use.openedDocumentState();
  const editingConversationId = useConversationStore.use.editingConversationId();
  const activeSubagentId = useViewerStore.use.activeSubagentId();
  const activeWorkflowRunId = useViewerStore.use.activeWorkflowRunId();
  const activeToolDetail = useViewerStore.use.activeToolDetail();
  const closeToolDetail = useViewerStore.use.closeToolDetail();
  const activeActivitySteps = useViewerStore.use.activeActivitySteps();
  const closeActivitySteps = useViewerStore.use.closeActivitySteps();
  // Subscribe to only the active subagent's entry rather than the whole `byId`
  // map, so streaming events from *other* subagents don't re-render the chat
  // layout (and the chat transcript it hosts) on every token.
  const activeSubagentEntry = useSubagentStore((s) =>
    activeSubagentId ? s.byId[activeSubagentId] : undefined,
  );
  const workflowById = useWorkflowStore((s) => s.byId);
  const activeAcpRunId = useViewerStore.use.activeAcpRunId();
  // Active run's entry only — same narrow selector as the subagent entry above.
  const activeAcpRunEntry = useAcpRunStore((s) =>
    activeAcpRunId ? s.byId[activeAcpRunId] : undefined,
  );
  const activeBackgroundTaskId = useViewerStore.use.activeBackgroundTaskId();
  // Active task's entry only — same narrow selector as the entries above.
  const activeBackgroundTaskEntry = useBackgroundTaskStore((s) =>
    activeBackgroundTaskId ? s.byId[activeBackgroundTaskId] : undefined,
  );
  const activeSkillDetailId = useViewerStore.use.activeSkillDetailId();
  const activeChannelSetup = useViewerStore.use.activeChannelSetup();

  const isSharing = useDeployStore.use.isSharing();
  const isDeploying = useDeployStore.use.isDeploying();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const editApp = useEditApp();

  // -------------------------------------------------------------------------
  // Side-panel callbacks (store operations only — no hook-local state)
  // -------------------------------------------------------------------------

  const handleCloseApp = useCallback(() => {
    useViewerStore.getState().closeApp();
    useConversationStore.getState().setEditingConversationId(null);
  }, []);

  const handleCloseEditPanel = useCallback(() => {
    useConversationStore.getState().setEditingConversationId(null);
    useViewerStore.getState().exitAppEditing();
  }, []);

  const handleEditApp = useCallback(() => {
    const oas = useViewerStore.getState().openedAppState;
    if (oas) editApp(oas);
  }, [editApp]);

  const handleShareApp = useCallback(() => {
    const app = useViewerStore.getState().openedAppState;
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (app && aid) void useDeployStore.getState().shareApp(aid, app.appId, app.name);
  }, []);

  const handleDeployApp = useCallback(() => {
    const app = useViewerStore.getState().openedAppState;
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (app && aid) void useDeployStore.getState().deployApp(aid, app.appId, app.name, app.html);
  }, []);

  const handleAppAction = useCallback(
    (actionId: string, data?: Record<string, unknown>) =>
      handleAppViewerAction({ navigate, isMobile }, actionId, data),
    [navigate, isMobile],
  );

  const handleCloseDocument = useCallback(() => {
    useViewerStore.getState().closeDocument();
  }, []);

  const onCloseSubagentDetail = useCallback(() => {
    useViewerStore.getState().closeSubagentDetail();
  }, []);

  const onStopSubagent = useCallback(
    (subagentId: string) => void useSubagentStore.getState().abortSubagent(subagentId),
    [],
  );

  const onRequestSubagentDetail = useCallback((id: string) => {
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (!aid) return;
    void useSubagentStore.getState().fetchDetailIfNeeded(aid, id);
  }, []);

  const onCloseWorkflowDetail = useCallback(() => {
    useViewerStore.getState().closeWorkflowDetail();
  }, []);

  const onStopWorkflow = useCallback(
    (runId: string) => void useWorkflowStore.getState().abortRun(runId),
    [],
  );

  const onRequestWorkflowJournal = useCallback((runId: string) => {
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (!aid) return;
    void useWorkflowStore.getState().fetchJournalIfNeeded(aid, runId);
  }, []);

  const onCloseAcpRunDetail = useCallback(() => {
    useViewerStore.getState().closeAcpRunDetail();
  }, []);

  const onCloseBackgroundTaskDetail = useCallback(() => {
    useViewerStore.getState().closeBackgroundTaskDetail();
  }, []);

  const onCloseSkillDetail = useCallback(() => {
    useViewerStore.getState().closeSkillDetail();
  }, []);

  const onCloseChannelSetup = useCallback(() => {
    useViewerStore.getState().closeChannelSetup();
  }, []);

  // -------------------------------------------------------------------------
  // Mobile fallback: side-drawer panels don't render on narrow viewports, so
  // redirect to the Channels tab with the channel's setup form pre-opened.
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isMobile) return;
    if (mainView !== "channel-setup" || !activeChannelSetup) return;
    const channel = activeChannelSetup.channel;
    // This close is a hand-off, not a dismissal: setup continues on the
    // Channels page, which runs standalone and cannot auto-notify on
    // completion. Signal the hand-off so the assistant switches to the
    // "tell me when you're done" flow instead of waiting for a
    // wizard-closed notification that will never come. Fired before the
    // store close so the close-notify watcher (which skips narrow
    // viewports) can never race it.
    void notifyChannelSetupHandedOff(activeChannelSetup);
    useViewerStore.getState().closeChannelSetup();
    navigate(`${routes.channels}?setup=${channel}`);
  }, [isMobile, mainView, activeChannelSetup, navigate]);

  // Same hand-off for the skill detail panel: narrowing the viewport with the
  // panel open (resize/rotation) would otherwise strand the viewer store in
  // "skill-detail" with nothing rendered — the right panel is desktop-only,
  // MobileChatOverlays has no skill-detail entry, and mobile Escape is
  // disabled. Redirect to the dedicated skill detail page instead (the same
  // destination the in-chat card uses on mobile). Unlike channel setup, no
  // hand-off notification is needed — the detail page is self-contained.
  useEffect(() => {
    if (!isMobile) return;
    if (mainView !== "skill-detail" || !activeSkillDetailId) return;
    useViewerStore.getState().closeSkillDetail();
    navigate(routes.skills.detail(activeSkillDetailId));
  }, [isMobile, mainView, activeSkillDetailId, navigate]);

  // -------------------------------------------------------------------------
  // Escape closes whichever right-hand side panel is open (tool detail /
  // thought process, subagent detail, workflow detail, acp run detail,
  // skill detail, document viewer). Surfaces stacked
  // above the panel that own Escape — Radix layers (dialogs, popovers,
  // dropdowns), the command palette, voice recording, the attachment
  // preview — all run before this bubble-phase window listener (document
  // capture or React tree handlers) and call preventDefault when they
  // consume the key, so `defaultPrevented` means the keypress was already
  // claimed by something above the panel. The full-width app viewer and the
  // app-editing split are deliberately excluded: the viewer owns Escape for
  // fullscreen exit, and editing is an explicit session with its own close
  // affordance. Closing restores `viewBefore*`, so repeated presses unwind
  // stacked panels (tool detail → document → chat) one layer at a time.
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (isMobile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Don't intercept IME composition (CJK input confirmation).
      if (event.isComposing || event.keyCode === 229) return;
      const viewer = useViewerStore.getState();
      switch (viewer.mainView) {
        case "tool-detail":
          viewer.closeToolDetail();
          break;
        case "activity-steps":
          viewer.closeActivitySteps();
          break;
        case "subagent-detail":
          viewer.closeSubagentDetail();
          break;
        case "workflow-detail":
          viewer.closeWorkflowDetail();
          break;
        case "acp-run-detail":
          viewer.closeAcpRunDetail();
          break;
        case "background-task-detail":
          viewer.closeBackgroundTaskDetail();
          break;
        case "skill-detail":
          viewer.closeSkillDetail();
          break;
        case "channel-setup":
          viewer.closeChannelSetup();
          break;
        case "document":
          viewer.closeDocument();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile]);

  // Warm the lazy side-panel chunks while the browser is idle so the first
  // open renders immediately instead of stalling on a dynamic import.
  useEffect(() => {
    // Swallow prefetch rejections: this is best-effort warming, so a chunk
    // 404 (offline / stale deploy) must not surface as an unhandledrejection.
    // The real load path on open still reports errors via LazyBoundary.
    const run = () => {
      importSubagentDetailPanel().catch(() => {});
      importToolDetailPanel().catch(() => {});
      importActivityStepsPanel().catch(() => {});
      importAcpRunDetailPanel().catch(() => {});
      importWorkflowDetailPanel().catch(() => {});
      importBackgroundTaskDetailPanel().catch(() => {});
      importSkillDetailPanel().catch(() => {});
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 200);
    return () => window.clearTimeout(id);
  }, []);

  // -------------------------------------------------------------------------
  // Layout routing
  // -------------------------------------------------------------------------

  // App editing: resizable split with chat + app editor
  if (mainView === "app-editing" && openedAppState && editingConversationId) {
    return (
      <ResizablePanel
        storageKey="appEditPanelWidth"
        hideDivider
        defaultRightWidth={400}
        minLeftWidth={300}
        minRightWidth={400}
        left={<ChatMainPanel {...props} />}
        right={
          <AppViewerContainer
            appId={openedAppState.appId}
            appName={openedAppState.name}
            html={openedAppState.html}
            assistantId={assistantId ?? ""}
            onClose={handleCloseApp}
            onEdit={handleCloseEditPanel}
            onShare={handleShareApp}
            isSharing={isSharing}
            onDeploy={handleDeployApp}
            isDeploying={isDeploying}
            onAction={handleAppAction}
            isEditing
          />
        }
      />
    );
  }

  // Desktop full-width app viewer (non-editing). Mobile uses the
  // portal-based MobileAppOverlay — this branch is desktop-only.
  if (mainView === "app" && !isMobile) {
    if (!openedAppState) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
        </div>
      );
    }
    return (
      <AppViewerContainer
        appId={openedAppState.appId}
        appName={openedAppState.name}
        html={openedAppState.html}
        assistantId={assistantId ?? ""}
        onClose={handleCloseApp}
        onEdit={handleEditApp}
        onShare={handleShareApp}
        isSharing={isSharing}
        onDeploy={handleDeployApp}
        isDeploying={isDeploying}
        onAction={handleAppAction}
      />
    );
  }

  const chatContent = <ChatMainPanel {...props} />;

  // Right-hand detail panels — document viewer, subagent detail, tool detail,
  // and workflow detail — all share ONE AnimatedRightDrawer so the chat
  // (`left`) keeps a stable position in the React tree and is NEVER unmounted
  // when a panel opens, closes, or switches between them. Only the (lazy,
  // lightweight) right-pane subtree changes; the transcript keeps its DOM and
  // scroll position. The drawer eases its width 0 ⇄ target, so opening/closing
  // reflows the chat in lockstep; drag-to-resize + width persistence are
  // built in. On mobile these panels render via portal overlays, so the
  // drawer stays closed (`open=false`) and the chat fills the width.
  //
  // (app-editing and the full-width app viewer keep their own returns above:
  // they replace or split the chat differently and are entered far less often,
  // so an occasional chat remount on those transitions is acceptable.)
  let rightPanel: ReactNode = null;
  if (!isMobile) {
    if (mainView === "document" && openedDocumentState && assistantId) {
      rightPanel = (
        <DocumentViewerContainer
          documentName={openedDocumentState.documentName}
          content={openedDocumentState.content}
          onClose={handleCloseDocument}
          assistantId={assistantId}
          surfaceId={openedDocumentState.surfaceId}
          conversationId={openedDocumentState.conversationId}
          onSubmitFeedback={() => {
            const prompt = `Please review and address my comments on "${openedDocumentState.documentName}".`;
            navigate(
              routes.conversationWithPrompt(
                openedDocumentState.conversationId,
                prompt,
              ),
            );
          }}
        />
      );
    } else if (
      mainView === "subagent-detail" &&
      activeSubagentId &&
      activeSubagentEntry
    ) {
      rightPanel = (
        <LazyBoundary>
          <SubagentDetailPanel
            entry={activeSubagentEntry}
            onClose={onCloseSubagentDetail}
            onStop={onStopSubagent}
            onRequestDetail={onRequestSubagentDetail}
          />
        </LazyBoundary>
      );
    } else if (mainView === "tool-detail" && activeToolDetail) {
      rightPanel = (
        <LazyBoundary>
          <ToolDetailPanel
            detail={activeToolDetail}
            onClose={closeToolDetail}
            onRiskBadgeClick={() => useViewerStore.getState().requestRuleEditorForActiveTool()}
          />
        </LazyBoundary>
      );
    } else if (mainView === "activity-steps" && activeActivitySteps) {
      rightPanel = (
        <LazyBoundary>
          <ActivityStepsPanel
            // Re-key per group so the drill-in level resets when a different
            // group's header is clicked while the panel is already open.
            key={`${activeActivitySteps.messageId ?? "snapshot"}:${
              activeActivitySteps.groupIndex ??
              activeActivitySteps.toolCalls[0]?.id ??
              ""
            }`}
            payload={activeActivitySteps}
            onClose={closeActivitySteps}
          />
        </LazyBoundary>
      );
    } else if (
      mainView === "acp-run-detail" &&
      activeAcpRunId &&
      activeAcpRunEntry
    ) {
      rightPanel = (
        <LazyBoundary>
          <AcpRunDetailPanel
            entry={activeAcpRunEntry}
            onClose={onCloseAcpRunDetail}
          />
        </LazyBoundary>
      );
    } else if (
      mainView === "background-task-detail" &&
      activeBackgroundTaskId &&
      activeBackgroundTaskEntry
    ) {
      rightPanel = (
        <LazyBoundary>
          <BackgroundTaskDetailPanel
            entry={activeBackgroundTaskEntry}
            onClose={onCloseBackgroundTaskDetail}
          />
        </LazyBoundary>
      );
    } else if (
      mainView === "workflow-detail" &&
      activeWorkflowRunId &&
      workflowById[activeWorkflowRunId]
    ) {
      rightPanel = (
        <LazyBoundary>
          <WorkflowDetailPanel
            entry={workflowById[activeWorkflowRunId]}
            onClose={onCloseWorkflowDetail}
            onStop={onStopWorkflow}
            onRequestJournal={onRequestWorkflowJournal}
          />
        </LazyBoundary>
      );
    } else if (mainView === "skill-detail" && activeSkillDetailId) {
      rightPanel = (
        <LazyBoundary>
          <SkillDetailPanel
            skillId={activeSkillDetailId}
            onClose={onCloseSkillDetail}
          />
        </LazyBoundary>
      );
    } else if (mainView === "channel-setup" && activeChannelSetup) {
      rightPanel = (
        <ChannelSetupPanel
          payload={activeChannelSetup}
          onClose={onCloseChannelSetup}
        />
      );
    }
  }

  return (
    <AnimatedRightDrawer
      storageKey="rightPanelWidth"
      defaultWidth={400}
      minWidth={400}
      minLeftWidth={300}
      open={rightPanel != null}
      left={chatContent}
      right={rightPanel}
    />
  );
}

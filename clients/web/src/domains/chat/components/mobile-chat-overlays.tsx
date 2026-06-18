/**
 * Portal-based mobile overlay container for app, document, subagent-detail,
 * and tool-detail viewers. Reads from Zustand stores directly so the parent
 * (ActiveChatView) doesn't need to assemble inline handlers.
 *
 * Renders nothing on desktop viewports (useMobileOverlayTarget returns null).
 */

import { useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

import { MobileAppOverlay } from "@/domains/chat/components/mobile-app-overlay";
import { MobileDocumentOverlay } from "@/domains/chat/components/mobile-document-overlay";
import { MobileSubagentDetailOverlay } from "@/domains/chat/components/mobile-subagent-detail-overlay";
import { MobileToolDetailOverlay } from "@/domains/chat/components/mobile-tool-detail-overlay";
import { MobileWorkflowDetailOverlay } from "@/domains/chat/components/mobile-workflow-detail-overlay";
import { useMobileOverlayTarget } from "@/domains/chat/hooks/use-mobile-overlay-target";

export function MobileChatOverlays() {
  const overlayTarget = useMobileOverlayTarget();
  const navigate = useNavigate();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();
  const openedDocumentState = useViewerStore.use.openedDocumentState();
  const isAppMinimized = useViewerStore.use.isAppMinimized();
  const activeSubagentId = useViewerStore.use.activeSubagentId();
  const activeToolDetail = useViewerStore.use.activeToolDetail();
  const activeWorkflowRunId = useViewerStore.use.activeWorkflowRunId();
  const subagentById = useSubagentStore.use.byId();
  const workflowById = useWorkflowStore.use.byId();
  const isSharing = useDeployStore.use.isSharing();
  const isDeploying = useDeployStore.use.isDeploying();
  const handleCloseApp = useCallback(() => {
    useViewerStore.getState().closeApp();
    useConversationStore.getState().setEditingConversationId(null);
  }, []);

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

  const handleCloseDocument = useCallback(() => {
    useViewerStore.getState().closeDocument();
  }, []);

  const handleDocumentSubmitFeedback = useCallback(() => {
    const docState = useViewerStore.getState().openedDocumentState;
    if (!docState) return;
    const prompt = `Please review and address my comments on "${docState.documentName}".`;
    navigate(
      `${routes.conversation(docState.conversationId)}?prompt=${encodeURIComponent(prompt)}`,
    );
  }, [navigate]);

  const handleCloseSubagentDetail = useCallback(() => {
    useViewerStore.getState().closeSubagentDetail();
  }, []);

  const handleStopSubagent = useCallback(
    (subagentId: string) => void useSubagentStore.getState().abortSubagent(subagentId),
    [],
  );

  const handleRequestSubagentDetail = useCallback((subagentId: string) => {
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (!aid) return;
    void useSubagentStore.getState().fetchDetailIfNeeded(aid, subagentId);
  }, []);

  const handleCloseWorkflowDetail = useCallback(() => {
    useViewerStore.getState().closeWorkflowDetail();
  }, []);

  const handleStopWorkflow = useCallback(
    (runId: string) => void useWorkflowStore.getState().abortRun(runId),
    [],
  );

  const handleRequestWorkflowJournal = useCallback((runId: string) => {
    const aid = useResolvedAssistantsStore.getState().activeAssistantId;
    if (!aid) return;
    void useWorkflowStore.getState().fetchJournalIfNeeded(aid, runId);
  }, []);

  const handleCloseToolDetail = useCallback(() => {
    useViewerStore.getState().closeToolDetail();
  }, []);

  const handleToolDetailRiskBadgeClick = useCallback(() => {
    useViewerStore.getState().requestRuleEditorForActiveTool();
  }, []);

  if (!overlayTarget) return null;

  return createPortal(
    <>
      <MobileAppOverlay
        openedAppState={mainView === "app" ? openedAppState : null}
        isAppMinimized={isAppMinimized}
        assistantId={assistantId}
        onToggleMinimized={() => {
          useViewerStore.getState().toggleAppMinimized();
        }}
        onClose={handleCloseApp}
        onShare={handleShareApp}
        isSharing={isSharing}
        onDeploy={handleDeployApp}
        isDeploying={isDeploying}
      />
      <MobileDocumentOverlay
        openedDocumentState={mainView === "document" ? openedDocumentState : null}
        assistantId={assistantId}
        onClose={handleCloseDocument}
        onSubmitFeedback={handleDocumentSubmitFeedback}
      />
      <MobileSubagentDetailOverlay
        entry={
          mainView === "subagent-detail" && activeSubagentId
            ? subagentById[activeSubagentId] ?? null
            : null
        }
        onClose={handleCloseSubagentDetail}
        onStop={handleStopSubagent}
        onRequestDetail={handleRequestSubagentDetail}
      />
      <MobileWorkflowDetailOverlay
        entry={
          mainView === "workflow-detail" && activeWorkflowRunId
            ? workflowById[activeWorkflowRunId] ?? null
            : null
        }
        onClose={handleCloseWorkflowDetail}
        onStop={handleStopWorkflow}
        onRequestJournal={handleRequestWorkflowJournal}
      />
      <MobileToolDetailOverlay
        detail={mainView === "tool-detail" ? activeToolDetail : null}
        onClose={handleCloseToolDetail}
        onRiskBadgeClick={handleToolDetailRiskBadgeClick}
      />
    </>,
    overlayTarget,
  );
}

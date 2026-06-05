/**
 * Chat content layout — routes the active `mainView` to the appropriate
 * panel arrangement.
 *
 * Single responsibility: reads `mainView` from the viewer store, renders
 * `ChatRouteContent` inside the correct layout shell (standalone, or
 * as the left pane of a `ResizablePanel` with a side panel on the right).
 *
 * Side-panel state (app, document, subagent, tool-detail) is read directly
 * from stores — no props required for layout decisions.
 */

import { lazy, useCallback } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { ResizablePanel } from "@vellumai/design-library";
import { LazyBoundary } from "@/components/lazy-boundary";
import { AppViewerContainer } from "@/components/app-viewer-container";
import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container";
import { ChatRouteContent, type ChatRouteContentProps } from "@/domains/chat/components/chat-route-content";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useEditApp } from "@/hooks/use-edit-app";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

const SubagentDetailPanel = lazy(() =>
  import("@/domains/chat/components/subagent-detail-panel").then((m) => ({
    default: m.SubagentDetailPanel,
  })),
);
const ToolDetailPanel = lazy(() =>
  import("@/domains/chat/components/tool-detail-panel").then((m) => ({
    default: m.ToolDetailPanel,
  })),
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatContentLayout(props: ChatRouteContentProps) {
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();
  const openedDocumentState = useViewerStore.use.openedDocumentState();
  const editingConversationId = useConversationStore.use.editingConversationId();
  const activeSubagentId = useViewerStore.use.activeSubagentId();
  const activeToolDetail = useViewerStore.use.activeToolDetail();
  const closeToolDetail = useViewerStore.use.closeToolDetail();
  const subagentById = useSubagentStore((s) => s.byId);

  const isSharing = useDeployStore.use.isSharing();
  const isDeploying = useDeployStore.use.isDeploying();
  const deployToVercel = useAssistantFeatureFlagStore.use.deployToVercel();
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

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
    const aid = useAssistantSelectionStore.getState().activeAssistantId;
    if (app && aid) void useDeployStore.getState().shareApp(aid, app.appId, app.name);
  }, []);

  const handleDeployApp = useCallback(() => {
    const app = useViewerStore.getState().openedAppState;
    const aid = useAssistantSelectionStore.getState().activeAssistantId;
    if (app && aid) void useDeployStore.getState().deployApp(aid, app.appId, app.name, app.html);
  }, []);

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
    const aid = useAssistantSelectionStore.getState().activeAssistantId;
    if (!aid) return;
    void useSubagentStore.getState().fetchDetailIfNeeded(aid, id);
  }, []);

  // -------------------------------------------------------------------------
  // Layout routing
  // -------------------------------------------------------------------------

  // App editing: resizable split with chat + app editor
  if (mainView === "app-editing" && openedAppState && editingConversationId) {
    return (
      <ResizablePanel
        storageKey="appEditPanelWidth"
        defaultRightWidth={400}
        minLeftWidth={300}
        minRightWidth={400}
        left={<ChatRouteContent {...props} />}
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
            onDeploy={deployToVercel ? handleDeployApp : undefined}
            isDeploying={isDeploying}
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
        onDeploy={deployToVercel ? handleDeployApp : undefined}
        isDeploying={isDeploying}
      />
    );
  }

  const chatContent = <ChatRouteContent {...props} />;

  // Document viewer side panel
  if (mainView === "document" && !isMobile && openedDocumentState && assistantId) {
    return (
      <ResizablePanel
        storageKey="documentPanelWidth"
        defaultRightWidth={400}
        minLeftWidth={300}
        minRightWidth={400}
        left={chatContent}
        right={
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
                `${routes.conversation(openedDocumentState.conversationId)}?prompt=${encodeURIComponent(prompt)}`,
              );
            }}
          />
        }
      />
    );
  }

  // Subagent detail side panel
  if (mainView === "subagent-detail" && activeSubagentId && !isMobile) {
    const activeEntry = subagentById[activeSubagentId];
    if (activeEntry) {
      return (
        <ResizablePanel
          storageKey="subagentDetailPanelWidth"
          defaultRightWidth={400}
          minLeftWidth={300}
          minRightWidth={400}
          left={chatContent}
          right={
            <LazyBoundary>
              <SubagentDetailPanel
                entry={activeEntry}
                onClose={onCloseSubagentDetail}
                onStop={onStopSubagent}
                onRequestDetail={onRequestSubagentDetail}
              />
            </LazyBoundary>
          }
        />
      );
    }
  }

  // Tool detail side panel
  if (mainView === "tool-detail" && activeToolDetail && !isMobile) {
    return (
      <ResizablePanel
        storageKey="toolDetailPanelWidth"
        defaultRightWidth={400}
        minLeftWidth={300}
        minRightWidth={400}
        hideDivider
        left={chatContent}
        right={
          <LazyBoundary>
            <ToolDetailPanel
              detail={activeToolDetail}
              onClose={closeToolDetail}
              onRiskBadgeClick={() => useViewerStore.getState().requestRuleEditorForActiveTool()}
            />
          </LazyBoundary>
        }
      />
    );
  }

  // Default: chat only
  return chatContent;
}

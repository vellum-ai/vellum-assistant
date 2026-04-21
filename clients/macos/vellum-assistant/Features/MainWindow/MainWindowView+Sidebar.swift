import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

// MARK: - Sidebar Content

extension MainWindowView {

    func selectConversation(_ conversation: ConversationModel) {
        if case .appEditing(_, let currentId) = windowState.selection,
           currentId == conversation.id {
            // Tapping the already-active conversation while editing an app
            // should not dismiss the app panel.
            return
        }
        // When an app is open, keep it visible and switch the conversation
        // context instead of navigating away to a full-screen conversation.
        if let appId = windowState.activeAppId {
            windowState.setAppEditing(appId: appId, conversationId: conversation.id)
        } else {
            windowState.selection = .conversation(conversation.id)
        }
        conversationManager.selectConversation(id: conversation.id)

        // Auto-expand the section containing the selected conversation
        // so it's always visible in the sidebar.
        if let groupId = conversation.groupId,
           !sidebar.expandedSections.contains(groupId) {
            sidebar.expandedSections.insert(groupId)
        }
    }

    func startNewConversation() {
        conversationManager.createConversation()
        SoundManager.shared.play(.newConversation)
        if let id = conversationManager.activeConversationId {
            // Keep the app visible when starting a new conversation from app mode
            if let appId = windowState.activeAppId {
                windowState.setAppEditing(appId: appId, conversationId: id)
            } else {
                windowState.selection = .conversation(id)
            }
        } else {
            // Draft mode — clear selection so no sidebar conversation is highlighted
            windowState.selection = nil
            windowState.persistentConversationId = nil
        }
    }

    /// Open an app in the workspace view (main content area).
    func openAppInWorkspace(app: AppListManager.AppItem) {
        // Reset sticky chat dock so apps open in view-only mode by default
        isAppChatOpen = false
        appListManager.recordAppOpen(
            id: app.id,
            name: app.name,
            icon: app.icon,
            previewBase64: app.previewBase64,
            appType: app.appType
        )
        Task { await AppsClient.openAppAndDispatchSurface(id: app.id, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
    }

    // MARK: - Mark All Read Toast

    func showMarkAllReadToast(count: Int, markedIds: [UUID]) {
        let toastId = windowState.showToast(
            message: "Marked \(count) conversation\(count == 1 ? "" : "s") as read",
            style: .success,
            primaryAction: VToastAction(label: "Undo") {
                conversationManager.restoreUnseen(conversationIds: markedIds)
                windowState.dismissToast()
            },
            onDismiss: {
                conversationManager.commitPendingSeenSignals()
            }
        )
        conversationManager.schedulePendingSeenSignals {
            windowState.dismissToast(id: toastId)
        }
    }

    // MARK: - Sidebar Construction

    /// Constructs the sidebar with all dependencies wired up. The body lives
    /// on the standalone `SidebarView` struct so it re-evaluates only when
    /// sidebar-relevant state changes.
    @ViewBuilder
    var sidebarView: some View {
        SidebarView(
            conversationManager: conversationManager,
            listStore: listStore,
            appListManager: appListManager,
            windowState: windowState,
            assistantFeatureFlagStore: assistantFeatureFlagStore,
            sidebar: sidebar,
            cachedAssistantName: cachedAssistantName,
            showAssistantLoading: showAssistantLoading,
            assistantLoadingTimedOut: assistantLoadingTimedOut,
            sidebarExpanded: sidebarExpanded,
            sidebarExpandedWidth: sidebarExpandedWidth,
            sidebarCollapsedWidth: sidebarCollapsedWidth,
            showConversationSwitcher: $showConversationSwitcher,
            conversationSwitcherTriggerFrame: $conversationSwitcherTriggerFrame,
            selectConversation: { selectConversation($0) },
            startNewConversation: { startNewConversation() },
            showMarkAllReadToast: { count, ids in showMarkAllReadToast(count: count, markedIds: ids) },
            openAppInWorkspace: { openAppInWorkspace(app: $0) }
        )
    }
}

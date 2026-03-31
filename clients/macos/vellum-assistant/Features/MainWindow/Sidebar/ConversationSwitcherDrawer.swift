import SwiftUI
import VellumAssistantShared

struct ConversationSwitcherDrawer: View {
    let regularConversations: [ConversationModel]
    let activeConversationId: UUID?
    @ObservedObject var conversationManager: ConversationManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    let selectConversation: (ConversationModel) -> Void
    let onDismiss: () -> Void

    private func isConversationSelected(_ conversation: ConversationModel) -> Bool {
        switch windowState.selection {
        case .panel:
            return false
        case .conversation(let id):
            return id == conversation.id
        case .appEditing(_, let conversationId):
            return conversationId == conversation.id
        case .app, .none:
            return conversation.id == windowState.persistentConversationId
        }
    }

    var body: some View {
        VMenu {
            VMenuSection(header: "\(regularConversations.count) conversations") {
                ForEach(regularConversations) { conversation in
                    SidebarConversationItem(
                        conversation: conversation,
                        isSelected: isConversationSelected(conversation),
                        interactionState: conversationManager.interactionState(for: conversation.id),
                        sidebarInteraction: sidebar,
                        selectConversation: { selectConversation(conversation) },
                        onSelect: onDismiss,
                        onTogglePin: {
                            withAnimation(VAnimation.standard) {
                                if conversation.isPinned {
                                    conversationManager.unpinConversation(id: conversation.id)
                                } else {
                                    conversationManager.pinConversation(id: conversation.id)
                                }
                            }
                        },
                        onArchive: { conversationManager.archiveConversation(id: conversation.id) },
                        onStartRename: {
                            sidebar.renamingConversationId = conversation.id
                            sidebar.renameText = conversation.title
                        },
                        onMarkUnread: { conversationManager.markConversationUnread(conversationId: conversation.id) },
                        onHoverChange: { hovering in
                            sidebar.setConversationHover(conversationId: conversation.id, hovering: hovering)
                        },
                        onDragStart: {
                            sidebar.draggingConversationId = conversation.id
                            sidebar.isHoveredConversation = nil
                        },
                        onOpenInNewWindow: conversation.conversationId != nil ? {
                            AppDelegate.shared?.threadWindowManager?.openThread(
                                conversationLocalId: conversation.id,
                                conversationManager: conversationManager
                            )
                        } : nil,
                        onShowFeedback: conversation.conversationId != nil && !LogExporter.isManagedAssistant ? {
                            AppDelegate.shared?.showLogReportWindow(scope: .conversation(conversationId: conversation.conversationId!, conversationTitle: conversation.title))
                        } : nil
                    )
                    .equatable()
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .onDisappear {
            if sidebar.isHoveredConversation != nil {
                sidebar.isHoveredConversation = nil
            }
        }
    }
}

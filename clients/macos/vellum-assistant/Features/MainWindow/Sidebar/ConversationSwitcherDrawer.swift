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
        VStack(spacing: SidebarLayoutMetrics.listRowGap) {
            Text("\(regularConversations.count) conversations")
                .font(VFont.labelDefault)
                .foregroundColor(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.xs)

            VColor.surfaceBase.frame(height: 1)
                .padding(.horizontal, VSpacing.xs)

            ForEach(regularConversations) { conversation in
                SidebarConversationItem(
                    conversation: conversation,
                    isSelected: isConversationSelected(conversation),
                    interactionState: conversationManager.interactionState(for: conversation.id),
                    isHovered: sidebar.isHoveredConversation == conversation.id,
                    isPendingDeletion: sidebar.conversationPendingDeletion == conversation.id,
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
                    onBeginArchive: { sidebar.conversationPendingDeletion = conversation.id },
                    onConfirmArchive: {
                        conversationManager.archiveConversation(id: conversation.id)
                        sidebar.conversationPendingDeletion = nil
                    },
                    onStartRename: {
                        sidebar.renamingConversationId = conversation.id
                        sidebar.renameText = conversation.title
                    },
                    onMarkUnread: { conversationManager.markConversationUnread(conversationId: conversation.id) },
                    onHoverChange: { hovering in
                        withAnimation(VAnimation.fast) {
                            sidebar.setConversationHover(conversationId: conversation.id, hovering: hovering)
                        }
                    },
                    onDragStart: {
                        sidebar.draggingConversationId = conversation.id
                        sidebar.isHoveredConversation = nil
                    },
                    onShowFeedback: conversation.conversationId != nil && !LogExporter.isManagedAssistant ? {
                        AppDelegate.shared?.showLogReportWindow(scope: .conversation(conversationId: conversation.conversationId!, conversationTitle: conversation.title))
                    } : nil
                )
                .equatable()
            }
        }
        .padding(VSpacing.sm)
        .fixedSize(horizontal: false, vertical: true)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
        .onDisappear {
            if sidebar.isHoveredConversation != nil {
                sidebar.isHoveredConversation = nil
            }
            sidebar.conversationPendingDeletion = nil
        }
    }
}

import SwiftUI
import VellumAssistantShared

/// Drop delegate for reordering regular (non-schedule) conversations in the sidebar.
/// Paired with `.onDrop(of:delegate:)` to avoid the eager `Transferable` witness
/// resolution overhead that `.dropDestination(for:)` incurs on every view graph update.
/// Identifies the drag source via `sidebar.draggingConversationId` (set by the drag
/// source's `onDragStart` callback) and returns `.move` to show the reorder cursor.
struct ConversationReorderDropDelegate: DropDelegate {
    let targetConversation: ConversationModel
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetConversation.id
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetConversation.id
        else { return }

        sidebar.dropTargetConversationId = targetConversation.id
        let visible = conversationManager.visibleConversations
        let sIdx = visible.firstIndex(where: { $0.id == dragId }) ?? 0
        let tIdx = visible.firstIndex(where: { $0.id == targetConversation.id }) ?? 0
        sidebar.dropIndicatorAtBottom = sIdx < tIdx
    }

    func dropExited(info: DropInfo) {
        if sidebar.dropTargetConversationId == targetConversation.id {
            sidebar.dropTargetConversationId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.dropTargetConversationId = nil
        sidebar.draggingConversationId = nil
        guard let sourceId = sourceId, sourceId != targetConversation.id else { return false }
        return conversationManager.moveConversation(sourceId: sourceId, targetId: targetConversation.id)
    }
}

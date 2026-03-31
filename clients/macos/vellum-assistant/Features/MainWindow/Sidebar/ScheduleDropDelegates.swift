import SwiftUI
import VellumAssistantShared

/// Drop delegate for reordering scheduled conversations within the same schedule group.
/// Returns `.move` operation to show a reorder cursor instead of the copy/plus icon.
struct ScheduleReorderDropDelegate: DropDelegate {
    let targetConversation: ConversationModel
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetConversation.id,
              let sourceConversation = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceConversation.isScheduleConversation,
              sourceConversation.groupId == targetConversation.groupId,
              sourceConversation.scheduleJobId == targetConversation.scheduleJobId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetConversation.id,
              let sourceConversation = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceConversation.isScheduleConversation,
              sourceConversation.groupId == targetConversation.groupId,
              sourceConversation.scheduleJobId == targetConversation.scheduleJobId
        else { return }

        sidebar.dropTargetConversationId = targetConversation.id
        // Use section-local index for direction detection (not global visibleConversations)
        let groupConversations = conversationManager.groupedConversations
            .first { $0.group?.id == targetConversation.groupId }?.conversations ?? []
        let sIdx = groupConversations.firstIndex(where: { $0.id == dragId }) ?? 0
        let tIdx = groupConversations.firstIndex(where: { $0.id == targetConversation.id }) ?? 0
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
        sidebar.endConversationDrag()
        guard let sourceId = sourceId, sourceId != targetConversation.id else { return false }
        return conversationManager.moveConversation(sourceId: sourceId, targetId: targetConversation.id)
    }
}

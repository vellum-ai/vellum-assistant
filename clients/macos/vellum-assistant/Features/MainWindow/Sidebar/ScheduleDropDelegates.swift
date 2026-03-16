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
              sourceConversation.scheduleJobId == targetConversation.scheduleJobId
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

/// Drop delegate for the collapsed schedule group header.
/// Targets the first conversation in the group; only accepts drops from the same schedule group.
struct ScheduleGroupHeaderDropDelegate: DropDelegate {
    let group: (key: String, label: String, conversations: [ConversationModel])
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    private var firstConversation: ConversationModel? { group.conversations.first }

    func validateDrop(info: DropInfo) -> Bool {
        guard let firstConversation = firstConversation,
              let dragId = sidebar.draggingConversationId,
              dragId != firstConversation.id,
              let sourceConversation = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceConversation.isScheduleConversation,
              sourceConversation.scheduleJobId == firstConversation.scheduleJobId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let firstConversation = firstConversation,
              let dragId = sidebar.draggingConversationId,
              dragId != firstConversation.id,
              let sourceConversation = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceConversation.isScheduleConversation,
              sourceConversation.scheduleJobId == firstConversation.scheduleJobId
        else { return }

        sidebar.dropTargetConversationId = firstConversation.id
        sidebar.dropIndicatorAtBottom = false
    }

    func dropExited(info: DropInfo) {
        if let firstConversation = firstConversation, sidebar.dropTargetConversationId == firstConversation.id {
            sidebar.dropTargetConversationId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.dropTargetConversationId = nil
        sidebar.draggingConversationId = nil
        guard let firstConversation = firstConversation,
              let sourceId = sourceId,
              sourceId != firstConversation.id
        else { return false }
        return conversationManager.moveConversation(sourceId: sourceId, targetId: firstConversation.id)
    }
}

import SwiftUI
import VellumAssistantShared

/// Drop delegate for reordering scheduled conversations within the same schedule group.
/// Returns `.move` operation to show a reorder cursor instead of the copy/plus icon.
struct ScheduleReorderDropDelegate: DropDelegate {
    let targetThread: ConversationModel
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetThread.id,
              let sourceThread = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceThread.isScheduleConversation,
              sourceThread.scheduleJobId == targetThread.scheduleJobId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let dragId = sidebar.draggingConversationId,
              dragId != targetThread.id,
              let sourceThread = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceThread.isScheduleConversation,
              sourceThread.scheduleJobId == targetThread.scheduleJobId
        else { return }

        sidebar.dropTargetConversationId = targetThread.id
        let visible = conversationManager.visibleConversations
        let sIdx = visible.firstIndex(where: { $0.id == dragId }) ?? 0
        let tIdx = visible.firstIndex(where: { $0.id == targetThread.id }) ?? 0
        sidebar.dropIndicatorAtBottom = sIdx < tIdx
    }

    func dropExited(info: DropInfo) {
        if sidebar.dropTargetConversationId == targetThread.id {
            sidebar.dropTargetConversationId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.dropTargetConversationId = nil
        sidebar.draggingConversationId = nil
        guard let sourceId = sourceId, sourceId != targetThread.id else { return false }
        return conversationManager.moveThread(sourceId: sourceId, targetId: targetThread.id)
    }
}

/// Drop delegate for the collapsed schedule group header.
/// Targets the first thread in the group; only accepts drops from the same schedule group.
struct ScheduleGroupHeaderDropDelegate: DropDelegate {
    let group: (key: String, label: String, conversations: [ConversationModel])
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    private var firstThread: ConversationModel? { group.conversations.first }

    func validateDrop(info: DropInfo) -> Bool {
        guard let firstThread = firstThread,
              let dragId = sidebar.draggingConversationId,
              dragId != firstThread.id,
              let sourceThread = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceThread.isScheduleConversation,
              sourceThread.scheduleJobId == firstThread.scheduleJobId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let firstThread = firstThread,
              let dragId = sidebar.draggingConversationId,
              dragId != firstThread.id,
              let sourceThread = conversationManager.visibleConversations.first(where: { $0.id == dragId }),
              sourceThread.isScheduleConversation,
              sourceThread.scheduleJobId == firstThread.scheduleJobId
        else { return }

        sidebar.dropTargetConversationId = firstThread.id
        sidebar.dropIndicatorAtBottom = false
    }

    func dropExited(info: DropInfo) {
        if let firstThread = firstThread, sidebar.dropTargetConversationId == firstThread.id {
            sidebar.dropTargetConversationId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.dropTargetConversationId = nil
        sidebar.draggingConversationId = nil
        guard let firstThread = firstThread,
              let sourceId = sourceId,
              sourceId != firstThread.id
        else { return false }
        return conversationManager.moveThread(sourceId: sourceId, targetId: firstThread.id)
    }
}

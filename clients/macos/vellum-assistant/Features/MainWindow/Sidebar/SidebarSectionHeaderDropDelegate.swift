import SwiftUI
import VellumAssistantShared

/// Drop delegate for sidebar section headers.
/// Handles conversation drops (M4) — group reorder (.group) returns false for now (M5 adds it).
struct SidebarSectionHeaderDropDelegate: DropDelegate {
    let groupId: String?
    let group: ConversationGroup?
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        // M4: only conversation drops are supported (via sidebar.draggingConversationId).
        // M5 extends this to also handle group reorder via SidebarDropPayload.parse.
        guard let sourceId = sidebar.draggingConversationId,
              let source = conversationManager.conversations.first(where: { $0.id == sourceId }),
              source.groupId != groupId else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        if let groupId {
            sidebar.dropTargetSectionId = groupId
        }
    }

    func dropExited(info: DropInfo) {
        if let groupId, sidebar.dropTargetSectionId == groupId {
            sidebar.dropTargetSectionId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.dropTargetSectionId = nil
        sidebar.draggingConversationId = nil
        guard let sourceId else { return false }
        // No-op if the conversation is already in this group (prevents clearing displayOrder)
        if let source = conversationManager.conversations.first(where: { $0.id == sourceId }),
           source.groupId == groupId { return false }
        conversationManager.moveConversationToGroup(sourceId, groupId: groupId)
        return true
    }
}

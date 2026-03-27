import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Drop delegate for sidebar section headers.
/// Handles conversation drops (M4) and group reorder drops (M5).
struct SidebarSectionHeaderDropDelegate: DropDelegate {
    let groupId: String?
    let group: ConversationGroup?
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        // Check if this is a group reorder drop first (M5).
        // Group drops come through as NSItemProvider with "group:" prefix.
        // We detect them by checking if there's NO draggingConversationId set
        // (group drags don't set draggingConversationId) AND the info contains items.
        if sidebar.draggingConversationId == nil {
            // Potential group drag — validate group reorder conditions
            guard let targetGroup = group, !targetGroup.isSystemGroup else { return false }
            // We can't parse the payload in validateDrop, but we know:
            // - Target must be a non-system group header
            // - The actual source validation happens in performDrop
            return true
        }

        // M4: conversation drop path
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
        sidebar.dropTargetSectionId = nil

        // Try to load dropped items to detect group vs conversation payload
        let providers = info.itemProviders(for: [.plainText])
        guard let provider = providers.first else {
            // Fallback to conversation drag path (M4)
            return performConversationDrop()
        }

        // Check for draggingConversationId first — if set, this is a conversation drag
        if sidebar.draggingConversationId != nil {
            return performConversationDrop()
        }

        // Async load the payload string for group reorder
        provider.loadObject(ofClass: NSString.self) { item, _ in
            guard let string = item as? String else { return }
            Task { @MainActor in
                guard let payload = SidebarDropPayload.parse(from: string) else { return }
                switch payload {
                case .conversation(let uuid):
                    // Late-arriving conversation drop
                    if let source = self.conversationManager.conversations.first(where: { $0.id == uuid }),
                       source.groupId != self.groupId {
                        self.conversationManager.moveConversationToGroup(uuid, groupId: self.groupId)
                    }
                case .group(let sourceId):
                    self.performGroupReorder(sourceId: sourceId)
                }
            }
        }
        return true
    }

    // MARK: - Conversation Drop (M4)

    private func performConversationDrop() -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.draggingConversationId = nil
        guard let sourceId else { return false }
        // No-op if the conversation is already in this group (prevents clearing displayOrder)
        if let source = conversationManager.conversations.first(where: { $0.id == sourceId }),
           source.groupId == groupId { return false }
        conversationManager.moveConversationToGroup(sourceId, groupId: groupId)
        return true
    }

    // MARK: - Group Reorder (M5)

    private func performGroupReorder(sourceId: String) {
        // Source must be a custom group (system groups can't be dragged)
        guard let source = conversationManager.groups.first(where: { $0.id == sourceId }),
              !source.isSystemGroup else { return }
        // Target must also be a custom group header
        guard let targetGroup = group, !targetGroup.isSystemGroup else { return }
        // No-op if dropping onto self
        guard sourceId != targetGroup.id else { return }

        // Reindex all custom groups to clean integer positions starting at 3.
        var customGroups = conversationManager.groups
            .filter { !$0.isSystemGroup }
            .sorted { $0.sortPosition < $1.sortPosition }
        customGroups.removeAll { $0.id == sourceId }
        let insertIdx = customGroups.firstIndex(where: { $0.id == targetGroup.id }) ?? customGroups.endIndex
        customGroups.insert(source, at: insertIdx)
        let updates = customGroups.enumerated().map { (i, g) in
            (groupId: g.id, sortPosition: Double(3 + i))
        }
        Task { await conversationManager.reorderGroups(updates) }
    }
}

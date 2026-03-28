import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Drop delegate for sidebar section headers.
/// Handles conversation drops (move into group) and group reorder drops.
///
/// Uses custom UTTypes (`sidebarConversation` / `sidebarGroup`) to distinguish
/// drag types in `validateDrop` via `info.hasItemsConforming(to:)`, rather than
/// relying on side-effect state (`draggingConversationId`).
struct SidebarSectionHeaderDropDelegate: DropDelegate {
    let groupId: String?
    let group: ConversationGroup?
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    func validateDrop(info: DropInfo) -> Bool {
        let isConversationDrag = info.hasItemsConforming(to: [.sidebarConversation])
        let isGroupDrag = info.hasItemsConforming(to: [.sidebarGroup])

        if isGroupDrag && !isConversationDrag {
            // Group reorder — only non-system group headers are valid targets
            guard let targetGroup = group, !targetGroup.isSystemGroup else { return false }
            return true
        }

        if isConversationDrag {
            // Conversation drop — all groups (including system groups like Pinned) accept.
            // Payload isn't available here, so accept optimistically;
            // performDrop validates fully (e.g., already-in-group check).
            guard group != nil else { return false }
            return true
        }

        return false
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

        // Fast path: draggingConversationId is set (common case)
        if sidebar.draggingConversationId != nil {
            return performConversationDrop()
        }

        // Async path: load payload from the custom UTType
        let providers = info.itemProviders(for: [.sidebarConversation, .sidebarGroup])
        guard let provider = providers.first else { return false }

        if provider.hasItemConformingToTypeIdentifier(UTType.sidebarConversation.identifier) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.sidebarConversation.identifier) { data, _ in
                guard let data, let string = String(data: data, encoding: .utf8),
                      let uuid = UUID(uuidString: string) else { return }
                Task { @MainActor in
                    self.performAsyncConversationDrop(sourceId: uuid)
                }
            }
            return true
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.sidebarGroup.identifier) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.sidebarGroup.identifier) { data, _ in
                guard let data, let string = String(data: data, encoding: .utf8),
                      let payload = SidebarDropPayload.parse(from: string) else { return }
                Task { @MainActor in
                    if case .group(let sourceId) = payload {
                        self.performGroupReorder(sourceId: sourceId)
                    }
                }
            }
            return true
        }

        return false
    }

    // MARK: - Conversation Drop

    private func performConversationDrop() -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.draggingConversationId = nil
        guard let sourceId else { return false }
        if let source = conversationManager.conversations.first(where: { $0.id == sourceId }),
           source.groupId == groupId { return false }

        if groupId == ConversationGroup.pinned.id {
            conversationManager.pinConversation(id: sourceId)
        } else {
            conversationManager.moveConversationToGroup(sourceId, groupId: groupId)
        }
        return true
    }

    /// Async fallback when `draggingConversationId` wasn't set at drop time.
    private func performAsyncConversationDrop(sourceId: UUID) {
        if let source = conversationManager.conversations.first(where: { $0.id == sourceId }),
           source.groupId == groupId { return }

        if groupId == ConversationGroup.pinned.id {
            conversationManager.pinConversation(id: sourceId)
        } else {
            conversationManager.moveConversationToGroup(sourceId, groupId: groupId)
        }
    }

    // MARK: - Group Reorder

    private func performGroupReorder(sourceId: String) {
        guard let source = conversationManager.groups.first(where: { $0.id == sourceId }),
              !source.isSystemGroup else { return }
        guard let targetGroup = group, !targetGroup.isSystemGroup else { return }
        guard sourceId != targetGroup.id else { return }

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

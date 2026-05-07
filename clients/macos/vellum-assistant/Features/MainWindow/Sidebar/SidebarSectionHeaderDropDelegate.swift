import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Drop delegate for sidebar section headers.
/// Handles conversation drops (move to group) and group reorder drops.
struct SidebarSectionHeaderDropDelegate: DropDelegate {
    let groupId: String?
    let group: ConversationGroup?
    let sidebar: SidebarInteractionState
    let conversationManager: ConversationManager

    /// Whether this drop is a conversation being dragged (vs a group being dragged).
    private var isConversationDrag: Bool { sidebar.draggingConversationId != nil }

    func validateDrop(info: DropInfo) -> Bool {
        if isConversationDrag {
            guard let sourceId = sidebar.draggingConversationId,
                  let source = conversationManager.listStore.conversationsByLocalId[sourceId],
                  source.groupId != groupId else { return false }
            return true
        }
        // Group drag: accept plain-text payloads; performDrop parses the payload
        return info.hasItemsConforming(to: [.plainText])
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let groupId else { return }
        if isConversationDrag {
            // Conversation drag: highlight the group background
            sidebar.dropTargetSectionId = groupId
        } else if let targetGroup = group, !targetGroup.isSystemGroup {
            // Group drag: show the horizontal divider, not the highlight
            sidebar.dropTargetSectionId = groupId
            // Determine indicator direction from sort positions
            if let sourceId = sidebar.draggingGroupId,
               let sourceGroup = conversationManager.groups.first(where: { $0.id == sourceId }) {
                // Dragging down → indicator at bottom (insert after target)
                // Dragging up → indicator at top (insert before target)
                sidebar.groupDropIndicatorAtBottom = sourceGroup.sortPosition < targetGroup.sortPosition
            }
        }
    }

    func dropExited(info: DropInfo) {
        if let groupId, sidebar.dropTargetSectionId == groupId {
            sidebar.dropTargetSectionId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        sidebar.dropTargetSectionId = nil
        sidebar.draggingGroupId = nil

        // If we know it's a conversation drag, handle immediately
        if isConversationDrag {
            return performConversationDrop()
        }

        // Otherwise, load the payload to determine type
        let providers = info.itemProviders(for: [.plainText])
        guard let provider = providers.first else {
            return performConversationDrop()
        }

        provider.loadObject(ofClass: NSString.self) { item, _ in
            guard let string = item as? String else { return }
            Task { @MainActor in
                guard let payload = SidebarDropPayload.parse(from: string) else { return }
                switch payload {
                case .conversation(let uuid):
                    if let source = self.conversationManager.listStore.conversationsByLocalId[uuid],
                       source.groupId != self.groupId {
                        self.conversationManager.moveConversationToGroup(uuid, groupId: self.groupId)
                    }
                    self.sidebar.endConversationDrag()
                case .group(let sourceId):
                    self.performGroupReorder(sourceId: sourceId)
                }
            }
        }
        return true
    }

    // MARK: - Conversation Drop

    private func performConversationDrop() -> Bool {
        let sourceId = sidebar.draggingConversationId
        sidebar.endConversationDrag()
        guard let sourceId else { return false }
        if let source = conversationManager.listStore.conversationsByLocalId[sourceId],
           source.groupId == groupId { return false }
        conversationManager.moveConversationToGroup(sourceId, groupId: groupId)
        return true
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

        guard let sourceIdx = customGroups.firstIndex(where: { $0.id == sourceId }),
              let targetIdx = customGroups.firstIndex(where: { $0.id == targetGroup.id }) else { return }

        // Remove source from its current position
        customGroups.remove(at: sourceIdx)

        // Find target's new index after removal
        let newTargetIdx = customGroups.firstIndex(where: { $0.id == targetGroup.id }) ?? customGroups.endIndex

        // Insert after target when dragging down, before target when dragging up
        let insertIdx = sourceIdx < targetIdx ? newTargetIdx + 1 : newTargetIdx
        customGroups.insert(source, at: min(insertIdx, customGroups.count))

        let updates = customGroups.enumerated().map { (i, g) in
            (groupId: g.id, sortPosition: Double(4 + i))
        }
        Task { await conversationManager.reorderGroups(updates) }
    }
}

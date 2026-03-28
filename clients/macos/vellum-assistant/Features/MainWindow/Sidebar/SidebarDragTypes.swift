import UniformTypeIdentifiers

/// Custom UTTypes for sidebar drag-and-drop operations.
///
/// Using distinct UTTypes allows `DropDelegate.validateDrop` to distinguish
/// conversation drags from group drags via `info.hasItemsConforming(to:)`,
/// without relying on side-effect state like `draggingConversationId`.
extension UTType {
    /// Drag payload for conversation reorder/move operations.
    /// Payload is the conversation's UUID string.
    static let sidebarConversation = UTType(exportedAs: "ai.vellum.sidebar.conversation")

    /// Drag payload for group reorder operations.
    /// Payload is the group ID prefixed with "group:".
    static let sidebarGroup = UTType(exportedAs: "ai.vellum.sidebar.group")
}

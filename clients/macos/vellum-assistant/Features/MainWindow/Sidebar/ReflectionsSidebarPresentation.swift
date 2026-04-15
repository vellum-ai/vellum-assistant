import Foundation

/// Pure, testable logic for splitting a conversation list into the main
/// "conversations" feed and the separate "Reflections" section that
/// collects `source == "auto-analysis"` conversations.
///
/// The auto-analysis loop (see PR plan `auto-analyze-loop`) creates dedicated
/// conversations titled `"Analysis: <parent>"` and tagged with
/// `source == "auto-analysis"`. They should NOT appear in the main
/// conversation feed — users browse them separately under "Reflections".
struct ReflectionsSidebarPresentation {
    /// Conversations that should render in the regular sidebar sections
    /// (everything except auto-analysis conversations).
    let mainConversations: [ConversationModel]

    /// Conversations that belong under the "Reflections" section,
    /// sorted by `lastInteractedAt` descending so the most recent reflection
    /// appears on top (mirroring the Recents section sort).
    let reflections: [ConversationModel]

    /// Whether the Reflections section should render at all.
    /// Returns `false` when no auto-analysis conversations exist so the
    /// sidebar is identical to its pre-feature state when `auto-analyze`
    /// is off and nothing has populated the list.
    var showsReflectionsSection: Bool { !reflections.isEmpty }

    init(conversations: [ConversationModel]) {
        var main: [ConversationModel] = []
        var reflections: [ConversationModel] = []
        main.reserveCapacity(conversations.count)
        for conversation in conversations {
            if conversation.isAutoAnalysisConversation {
                reflections.append(conversation)
            } else {
                main.append(conversation)
            }
        }
        self.mainConversations = main
        self.reflections = reflections.sorted { $0.lastInteractedAt > $1.lastInteractedAt }
    }
}

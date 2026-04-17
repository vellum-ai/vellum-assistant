import Foundation

/// Shared source of truth for which messages count toward chat pagination and anchors.
/// Both `ChatViewModel` and the macOS `MessageListView` should use this to determine
/// the visible message set, ensuring consistent filtering rules across platforms.
public enum ChatVisibleMessageFilter {

    /// Returns all messages that should be visible in the chat UI.
    /// Excludes subagent notifications, hidden (automated) messages, and phantom
    /// messages with no renderable content (which can arise from streaming edge
    /// cases like API timeouts creating empty message shells).
    public static func visibleMessages(from messages: [ChatMessage]) -> [ChatMessage] {
        messages.filter { !$0.isSubagentNotification && !$0.isHidden && $0.hasRenderableContent }
    }

    /// Returns the paginated suffix of visible messages for a given `displayedMessageCount`.
    /// Filtering is applied first, then the suffix window is taken from the filtered set.
    /// When `displayedMessageCount >= visibleCount`, all visible messages are returned.
    public static func paginatedMessages(
        from messages: [ChatMessage],
        displayedMessageCount: Int
    ) -> [ChatMessage] {
        let visible = visibleMessages(from: messages)
        guard displayedMessageCount < visible.count else { return visible }
        return Array(visible.suffix(displayedMessageCount))
    }
}

import Foundation

/// Formats chat messages for clipboard export. Shared across platforms.
public enum ChatTranscriptFormatter {

    public struct ParticipantNames {
        public let assistantName: String
        public let userName: String

        public init(assistantName: String, userName: String) {
            self.assistantName = assistantName
            self.userName = userName
        }
    }

    /// Render an entire conversation as lightweight Markdown.
    /// - Parameters:
    ///   - messages: All messages in the conversation.
    ///   - conversationTitle: Optional conversation title (rendered as `# title`).
    ///   - participantNames: Display names for assistant and user.
    /// - Returns: Markdown string, or empty string if no text messages exist.
    /// Queued user messages (`role == .user && status is .queued`) are excluded so
    /// copy/share output stays consistent with the on-screen transcript, which
    /// collapses queued user messages into a single marker (see `TranscriptItems.build`).
    public static func conversationMarkdown(
        messages: [ChatMessage],
        conversationTitle: String?,
        participantNames: ParticipantNames
    ) -> String {
        let deliverableMessages = messages.filter { !isQueuedUser($0) }
        let textMessages = deliverableMessages.filter {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !textMessages.isEmpty else { return "" }

        var parts: [String] = []

        if let title = conversationTitle, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("# \(title)")
        }

        let messageParts = textMessages.map { message -> String in
            let sender = message.role == .assistant
                ? participantNames.assistantName
                : participantNames.userName
            return "### \(sender)\n\(message.text)"
        }

        parts.append(messageParts.joined(separator: "\n\n---\n\n"))

        return parts.joined(separator: "\n\n")
    }

    /// Plain text content of a single message for per-message copy.
    /// Returns the trimmed text, or empty string if the message has no text content.
    public static func messagePlainText(_ message: ChatMessage) -> String {
        message.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// True when the message is a queued user message (not yet sent to the assistant).
    /// Mirrors the same `role == .user && case .queued = status` check used in
    /// `ChatViewModel`, `TranscriptItems`, and the queue-drawer code paths.
    private static func isQueuedUser(_ message: ChatMessage) -> Bool {
        guard message.role == .user else { return false }
        if case .queued = message.status { return true }
        return false
    }
}

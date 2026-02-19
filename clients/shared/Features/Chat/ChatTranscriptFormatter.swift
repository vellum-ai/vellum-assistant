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

    /// Render an entire thread as lightweight Markdown.
    /// - Parameters:
    ///   - messages: All messages in the thread.
    ///   - threadTitle: Optional thread title (rendered as `# title`).
    ///   - participantNames: Display names for assistant and user.
    /// - Returns: Markdown string, or empty string if no text messages exist.
    public static func threadMarkdown(
        messages: [ChatMessage],
        threadTitle: String?,
        participantNames: ParticipantNames
    ) -> String {
        let textMessages = messages.filter {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !textMessages.isEmpty else { return "" }

        var parts: [String] = []

        if let title = threadTitle, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
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
}

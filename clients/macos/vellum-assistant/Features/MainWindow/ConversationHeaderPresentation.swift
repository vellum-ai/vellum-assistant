import Foundation
import VellumAssistantShared

/// Presentation model for the thread title + actions control in the top bar.
/// Keeps UI logic deterministic and testable.
@MainActor
struct ConversationHeaderPresentation {
    let displayTitle: String
    let isStarted: Bool
    let showsActionsMenu: Bool
    let isPrivateThread: Bool
    let canCopy: Bool
    let isPinned: Bool

    init(activeConversation: ConversationModel?, activeViewModel: ChatViewModel?, isConversationVisible: Bool) {
        guard isConversationVisible, let thread = activeConversation else {
            self.displayTitle = "New thread"
            self.isStarted = false
            self.showsActionsMenu = false
            self.isPrivateThread = false
            self.canCopy = false
            self.isPinned = false
            return
        }

        self.displayTitle = thread.title
        self.isPinned = thread.isPinned
        self.isPrivateThread = thread.kind == .private

        // "Started" = has a sessionId OR has at least one non-empty user message
        let hasUserMessage = activeViewModel?.messages.contains(where: {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) ?? false
        self.isStarted = thread.conversationId != nil || hasUserMessage

        // Private conversations don't show the full actions menu
        self.showsActionsMenu = isStarted && !isPrivateThread

        // Can copy when there's non-empty content
        self.canCopy = hasUserMessage
    }
}

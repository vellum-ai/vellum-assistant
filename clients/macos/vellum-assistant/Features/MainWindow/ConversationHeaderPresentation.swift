import Foundation
import VellumAssistantShared

/// Presentation model for the conversation title + actions control in the top bar.
/// Keeps UI logic deterministic and testable.
@MainActor
struct ConversationHeaderPresentation {
    let displayTitle: String
    let isStarted: Bool
    let showsActionsMenu: Bool
    let isPrivateConversation: Bool
    let canCopy: Bool
    let isPinned: Bool
    let showsForkConversationAction: Bool
    let forkParentTitle: String?
    let forkParentConversationId: String?
    let forkParentMessageId: String?

    var showsForkParentLink: Bool {
        forkParentConversationId != nil
    }

    init(activeConversation: ConversationModel?, activeViewModel: ChatViewModel?, isConversationVisible: Bool) {
        guard isConversationVisible, let conversation = activeConversation else {
            self.displayTitle = "New conversation"
            self.isStarted = false
            self.showsActionsMenu = false
            self.isPrivateConversation = false
            self.canCopy = false
            self.isPinned = false
            self.showsForkConversationAction = false
            self.forkParentTitle = nil
            self.forkParentConversationId = nil
            self.forkParentMessageId = nil
            return
        }

        self.displayTitle = conversation.title
        self.isPinned = conversation.isPinned
        self.isPrivateConversation = conversation.kind == .private

        // "Started" = has a conversationId OR has at least one non-empty user message
        let hasUserMessage = activeViewModel?.messages.contains(where: {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) ?? false
        self.isStarted = conversation.conversationId != nil || hasUserMessage

        // Private conversations don't show the full actions menu
        self.showsActionsMenu = isStarted && !isPrivateConversation

        // Can copy when there's non-empty content
        self.canCopy = hasUserMessage
        self.showsForkConversationAction = conversation.conversationId != nil && !isPrivateConversation
        if isPrivateConversation {
            self.forkParentTitle = nil
            self.forkParentConversationId = nil
            self.forkParentMessageId = nil
        } else {
            self.forkParentTitle = conversation.forkParent?.title
            self.forkParentConversationId = conversation.forkParent?.conversationId
            self.forkParentMessageId = conversation.forkParent?.messageId
        }
    }
}

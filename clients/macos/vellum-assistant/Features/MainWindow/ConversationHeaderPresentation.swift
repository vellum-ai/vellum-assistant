import Foundation
import VellumAssistantShared

/// Presentation model for the conversation title + actions control in the top bar.
/// Keeps UI logic deterministic and testable.
@MainActor
struct ConversationHeaderPresentation {
    let localConversationId: UUID?
    let displayTitle: String
    let isStarted: Bool
    let showsActionsMenu: Bool
    let isPrivateConversation: Bool
    let isChannelConversation: Bool
    let canCopy: Bool
    let isPinned: Bool
    let isPersisted: Bool
    let showsForkConversationAction: Bool
    let forkParentTitle: String?
    let forkParentConversationId: String?
    let forkParentMessageId: String?

    var showsForkParentLink: Bool {
        forkParentConversationId != nil
    }

    init(activeConversation: ConversationModel?, activeViewModel: ChatViewModel?, isConversationVisible: Bool) {
        guard isConversationVisible, let conversation = activeConversation else {
            self.localConversationId = nil
            self.displayTitle = "New conversation"
            self.isStarted = false
            self.showsActionsMenu = false
            self.isPrivateConversation = false
            self.isChannelConversation = false
            self.canCopy = false
            self.isPinned = false
            self.isPersisted = false
            self.showsForkConversationAction = false
            self.forkParentTitle = nil
            self.forkParentConversationId = nil
            self.forkParentMessageId = nil
            return
        }

        self.localConversationId = conversation.id
        self.displayTitle = conversation.title
        self.isPinned = conversation.isPinned
        self.isPrivateConversation = conversation.kind == .private
        self.isChannelConversation = conversation.isChannelConversation

        // Read O(1) cached values from the model layer instead of scanning the
        // messages array. ChatMessageManager keeps these in sync via Combine
        // pipelines, avoiding O(n) work during view body evaluation.
        let hasNonEmptyMessage = activeViewModel?.hasNonEmptyMessage ?? false
        self.isStarted = conversation.conversationId != nil || hasNonEmptyMessage
        self.isPersisted = conversation.conversationId != nil

        // Private conversations don't show the full actions menu
        self.showsActionsMenu = isStarted && !isPrivateConversation

        // Can copy when there's non-empty content
        self.canCopy = hasNonEmptyMessage
        self.showsForkConversationAction =
            conversation.conversationId != nil
            && !isPrivateConversation
            && activeViewModel?.latestPersistedTipDaemonMessageId != nil
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

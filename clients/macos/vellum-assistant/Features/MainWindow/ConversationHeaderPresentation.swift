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
    let isChannelConversation: Bool
    let canCopy: Bool
    let isPinned: Bool
    let showsForkConversationAction: Bool
    let forkParentTitle: String?
    let forkParentConversationId: String?
    let forkParentMessageId: String?

    var showsForkParentLink: Bool {
        forkParentConversationId != nil
    }

    /// - Parameters:
    ///   - activeConversation: The currently active conversation model.
    ///   - activeViewModel: The chat view model for the active conversation.
    ///   - isConversationVisible: Whether the conversation panel is visible.
    ///   - hasNonEmptyMessage: O(1) cached boolean from
    ///     `ChatViewModel.hasNonEmptyMessage`, avoiding an O(n) message scan.
    init(activeConversation: ConversationModel?, activeViewModel: ChatViewModel?, isConversationVisible: Bool, hasNonEmptyMessage: Bool = false) {
        guard isConversationVisible, let conversation = activeConversation else {
            self.displayTitle = "New conversation"
            self.isStarted = false
            self.showsActionsMenu = false
            self.isPrivateConversation = false
            self.isChannelConversation = false
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
        self.isChannelConversation = conversation.isChannelConversation

        // "Started" = has a conversationId OR has at least one non-empty message
        self.isStarted = conversation.conversationId != nil || hasNonEmptyMessage

        // Private conversations don't show the full actions menu
        self.showsActionsMenu = isStarted && !isPrivateConversation

        // Can copy when there's non-empty content
        self.canCopy = hasNonEmptyMessage
        let latestPersistedTipDaemonMessageId = activeViewModel?.messages.last(where: {
            $0.daemonMessageId != nil && !$0.isStreaming && !$0.isHidden
        })?.daemonMessageId
        self.showsForkConversationAction =
            conversation.conversationId != nil
            && !isPrivateConversation
            && latestPersistedTipDaemonMessageId != nil
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

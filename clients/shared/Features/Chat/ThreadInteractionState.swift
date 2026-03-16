import Foundation

/// Describes the current interaction state of a conversation, derived from its
/// ChatViewModel's error, confirmation, and busy properties.
///
/// Priority order (highest to lowest): error > waitingForInput > processing > idle.
/// M2/M3 will use this to drive visual cues in the conversation list and chat view.
public enum ConversationInteractionState: Equatable, Sendable {
    /// Nothing happening — the conversation is at rest.
    case idle
    /// The assistant is thinking, sending, or has queued messages.
    case processing
    /// The conversation has a pending tool confirmation waiting for user approval.
    case waitingForInput
    /// The conversation has an active error (session error or error text).
    case error
}

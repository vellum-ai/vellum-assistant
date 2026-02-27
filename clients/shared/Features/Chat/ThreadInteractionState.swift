import Foundation

/// Describes the current interaction state of a thread, derived from its
/// ChatViewModel's error, confirmation, and busy properties.
///
/// Priority order (highest to lowest): error > waitingForInput > processing > idle.
/// M2/M3 will use this to drive visual cues in the thread list and chat view.
public enum ThreadInteractionState: Equatable, Sendable {
    /// Nothing happening — the thread is at rest.
    case idle
    /// The assistant is thinking, sending, or has queued messages.
    case processing
    /// The thread has a pending tool confirmation waiting for user approval.
    case waitingForInput
    /// The thread has an active error (session error or error text).
    case error
}

/// Deterministic selector for the single "active" pending confirmation in a
/// list of chat messages. Only the first pending confirmation in display order
/// should own keyboard focus; lower ones wait until promoted.
public enum PendingConfirmationFocusSelector {
    /// Returns the `requestId` of the first message whose confirmation is
    /// `.pending`, or `nil` if no pending confirmation exists.
    ///
    /// - Parameter messages: The ordered messages as rendered in the chat
    ///   (after any display filters have been applied).
    public static func activeRequestId(from messages: [ChatMessage]) -> String? {
        for message in messages {
            if let confirmation = message.confirmation, confirmation.state == .pending {
                return confirmation.requestId
            }
        }
        return nil
    }
}

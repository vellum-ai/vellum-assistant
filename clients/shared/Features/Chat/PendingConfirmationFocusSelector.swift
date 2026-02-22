/// Deterministic selector for the single "active" pending confirmation in a
/// list of chat messages. Only the first pending confirmation in display order
/// should own keyboard focus; lower ones wait until promoted.
public enum PendingConfirmationFocusSelector {
    /// Returns the `requestId` of the first keyboard-capable pending
    /// confirmation, or `nil` if none exists.
    ///
    /// System-permission requests (`request_system_permission`) are excluded
    /// because they render via a dedicated card without keyboard shortcut
    /// support. Including them would block keyboard focus for tool-confirmation
    /// bubbles stacked below.
    ///
    /// - Parameter messages: The ordered messages as rendered in the chat
    ///   (after any display filters have been applied).
    public static func activeRequestId(from messages: [ChatMessage]) -> String? {
        for message in messages {
            if let confirmation = message.confirmation,
               confirmation.state == .pending,
               !confirmation.isSystemPermissionRequest {
                return confirmation.requestId
            }
        }
        return nil
    }
}

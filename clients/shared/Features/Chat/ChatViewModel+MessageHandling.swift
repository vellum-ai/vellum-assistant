import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel+MessageHandling")

// MARK: - Message Handling (thin routing layer)

extension ChatViewModel {

    /// Routes incoming server messages to the `ChatActionHandler`.
    ///
    /// This extension is intentionally thin — all dispatch logic and
    /// per-case handlers live in `ChatActionHandler`. The only purpose
    /// of this forwarding method is to preserve the public API surface
    /// (`chatViewModel.handleServerMessage(_:)`) so callers don't need
    /// to know about the handler.
    public func handleServerMessage(_ message: ServerMessage) {
        actionHandler.handleServerMessage(message)
    }

    /// Convenience forwarding for conversation ownership checks that
    /// callers outside the action handler still need (e.g. history
    /// reconstruction, reconnect paths).
    func belongsToConversation(_ messageConversationId: String?) -> Bool {
        actionHandler.belongsToConversation(messageConversationId)
    }
}

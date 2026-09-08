import UserNotifications
import os

/// Entry point for the Notification Service Extension, which iOS runs for every
/// push carrying `mutable-content: 1` before the notification is shown.
///
/// A push whose payload carries a complete `sender` block is rewritten into a
/// Communication Notification so the assistant's avatar is the icon. Everything
/// else, including every push sent while the `push-avatar-sender` flag is off,
/// is delivered exactly as it arrived.
final class NotificationService: UNNotificationServiceExtension {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.vellum.assistant",
        category: "NotificationService"
    )

    /// Guards the one-shot handler against the rewrite and the expiry callback
    /// racing on different threads.
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var unchangedContent: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        lock.lock()
        self.contentHandler = contentHandler
        unchangedContent = request.content
        lock.unlock()

        let userInfo = request.content.userInfo
        guard let sender = SenderPayload.parse(userInfo: userInfo),
              let cache = AvatarCache.inAppGroup()
        else {
            deliver(request.content)
            return
        }
        let conversationId = SenderPayload.conversationIdentifier(
            userInfo: userInfo,
            senderId: sender.id
        )

        Task {
            var avatar = cache.data(forHash: sender.avatarHash)
            if avatar == nil, let url = sender.avatarURL {
                avatar = await cache.fetch(url: url, hash: sender.avatarHash)
            }
            guard let avatar else {
                Self.logger.info("No avatar for the push sender, delivering unchanged")
                self.deliver(request.content)
                return
            }
            do {
                self.deliver(
                    try await communicationContent(
                        from: request.content,
                        sender: sender,
                        avatar: avatar,
                        conversationId: conversationId
                    )
                )
            } catch {
                Self.logger.error(
                    "Communication notification rewrite failed: \(error.localizedDescription, privacy: .public)"
                )
                self.deliver(request.content)
            }
        }
    }

    /// Called when the extension runs out of its budget. Delivering the push as
    /// it arrived is the only alternative to the system dropping it silently.
    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let content = unchangedContent
        lock.unlock()
        if let content {
            deliver(content)
        }
    }

    /// Hands `content` to the system once. Later calls are dropped: iOS accepts
    /// a single delivery per push, and the rewrite can finish just as the
    /// expiry callback fires.
    private func deliver(_ content: UNNotificationContent) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        handler?(content)
    }
}

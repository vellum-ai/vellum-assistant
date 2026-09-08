import UserNotifications
import os

/// Entry point for the Notification Service Extension, which iOS runs for every
/// push carrying `mutable-content: 1` before the notification is shown.
///
/// A push whose payload carries a complete `sender` block is rewritten into a
/// Communication Notification so the assistant's avatar is the icon. Everything
/// else, including every push sent while the `push-avatar-sender` flag is off,
/// is delivered exactly as it arrived.
///
/// Every path that gives up on the rewrite logs one stable `nse.*` prefix
/// before delivering the push unchanged, so a device that shows plain
/// notifications can be diagnosed from Console with a single filter on `nse.`
/// rather than by guessing which of the five it took.
final class NotificationService: UNNotificationServiceExtension {
    /// Falls back to the production appex bundle id so a build that somehow
    /// reports no identifier still logs under a subsystem Console can filter,
    /// rather than one that matches nothing.
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier
            ?? "ai.vocify-inc.vellum-assistant-ios.NotificationService",
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

        guard let sender = SenderPayload.parse(userInfo: request.content.userInfo) else {
            Self.logger.info("nse.no_sender: push carries no complete sender block")
            deliver(request.content)
            return
        }
        guard let cache = AvatarCache.inAppGroup() else {
            Self.logger.error("nse.no_app_group: the appex declares no App Group container")
            deliver(request.content)
            return
        }

        Task {
            var avatar = cache.data(forHash: sender.avatarHash)
            if avatar == nil, let url = sender.avatarURL {
                avatar = await cache.fetch(url: url, hash: sender.avatarHash)
            }
            guard let avatar else {
                Self.logger.info("nse.avatar_unavailable: cache miss and no usable download")
                self.deliver(request.content)
                return
            }
            do {
                self.deliver(
                    try await communicationContent(
                        from: request.content,
                        sender: sender,
                        avatar: avatar
                    )
                )
            } catch {
                Self.logger.error(
                    "nse.intent_failed: \(error.localizedDescription, privacy: .public)"
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
            Self.logger.info("nse.expired: budget ran out before the rewrite finished")
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

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
    private var rewrite: Task<Void, Never>?
    private var expired = false

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

        let task = Task {
            let avatar: Data
            if let cached = cache.data(forHash: sender.avatarHash) {
                avatar = cached
            } else {
                let url: URL
                switch sender.avatarURL {
                case .url(let resolved):
                    url = resolved
                case .absent:
                    self.deliverWithoutAvatar(.missingURL, content: request.content)
                    return
                case .malformed:
                    self.deliverWithoutAvatar(.invalidURL, content: request.content)
                    return
                }
                switch await cache.fetch(url: url, hash: sender.avatarHash) {
                case .success(let downloaded):
                    avatar = downloaded
                case .failure(let reason):
                    self.deliverWithoutAvatar(reason, content: request.content)
                    return
                }
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
        lock.lock()
        rewrite = task
        let alreadyExpired = expired
        lock.unlock()
        // The task is built before it can be stored, so an expiry landing in
        // between finds nothing to cancel and the download outlives the
        // notification it was for.
        if alreadyExpired {
            task.cancel()
        }
    }

    /// Called when the extension runs out of its budget. Delivering the push as
    /// it arrived is the only alternative to the system dropping it silently.
    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        expired = true
        let content = unchangedContent
        let pending = rewrite
        rewrite = nil
        lock.unlock()
        // Cancelling propagates into the avatar download, whose only bound
        // otherwise is an idle timeout the system has already outlasted.
        pending?.cancel()
        guard let content, deliver(content) else {
            return
        }
        Self.logger.info("nse.expired: budget ran out before the rewrite finished")
    }

    /// Delivers the push as it arrived, and logs why it has no avatar when this
    /// is the delivery that reached the system. A cancelled download reports a
    /// reason after the expiry callback has already delivered, and that reason
    /// describes the cancellation rather than the notification the user saw.
    private func deliverWithoutAvatar(
        _ reason: AvatarCache.UnavailableReason,
        content: UNNotificationContent
    ) {
        guard deliver(content) else {
            return
        }
        Self.logger.info(
            "nse.avatar_unavailable reason=\(reason.rawValue, privacy: .public)"
        )
    }

    /// Hands `content` to the system once and reports whether it did. Later
    /// calls are dropped: iOS accepts a single delivery per push, and the
    /// rewrite can finish just as the expiry callback fires.
    @discardableResult
    private func deliver(_ content: UNNotificationContent) -> Bool {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        unchangedContent = nil
        lock.unlock()
        guard let handler else {
            return false
        }
        handler(content)
        return true
    }
}

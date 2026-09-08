import UserNotifications

/// Entry point for the Notification Service Extension, which iOS runs for every
/// push carrying `mutable-content: 1` before the notification is shown.
///
/// This is a passthrough: the content is delivered exactly as it arrived, so a
/// build carrying the extension renders today's notifications unchanged. The
/// handler and content are held anyway because the async rewrite that lands
/// next needs them, and because ``serviceExtensionTimeWillExpire()`` has
/// nothing else to deliver from.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content
        contentHandler(request.content)
    }

    /// Called when the extension runs out of its budget. Delivering the best
    /// attempt so far is the only alternative to the system dropping the
    /// modification silently.
    override func serviceExtensionTimeWillExpire() {
        guard let contentHandler, let bestAttemptContent else { return }
        contentHandler(bestAttemptContent)
    }
}

import UserNotifications

/// OS notification categories the iOS shell registers at launch.
///
/// Remote pushes can arrive before the Capacitor bridge has run, so the
/// category must exist in `UNUserNotificationCenter` independently of JS.
/// The identifier and action id stay aligned with
/// `NOTIFICATION_INTENT_ACTION_TYPE_ID` in `clients/web/src/runtime/notifications.ts`
/// and `APNS_CONVERSATION_CATEGORY` on the platform APNs sender.
enum NotificationCategories {
    static let intentIdentifier = "notificationIntent"
    static let viewActionIdentifier = "view"
    /// English fallback used before the web catalog can re-register a localized title.
    static let viewActionTitle = "Go to Conversation"

    static func intentCategory() -> UNNotificationCategory {
        let view = UNNotificationAction(
            identifier: viewActionIdentifier,
            title: viewActionTitle,
            options: [.foreground]
        )
        return UNNotificationCategory(
            identifier: intentIdentifier,
            actions: [view],
            intentIdentifiers: [],
            options: []
        )
    }

    static func register() {
        UNUserNotificationCenter.current().setNotificationCategories([
            intentCategory(),
        ])
    }
}

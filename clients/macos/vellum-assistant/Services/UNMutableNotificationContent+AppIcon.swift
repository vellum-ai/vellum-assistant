import Foundation
import UserNotifications

extension UNMutableNotificationContent {
    /// Attaches the app icon to the notification content so macOS displays it
    /// in banners and Notification Center (important for LSUIElement apps
    /// that have no dock icon).
    func attachAppIcon() {
        guard let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns")
                ?? Bundle(identifier: "com.vellum.vellum-assistant")?.url(forResource: "AppIcon", withExtension: "icns"),
              let attachment = try? UNNotificationAttachment(identifier: "app-icon", url: iconURL, options: nil)
        else { return }
        attachments = [attachment]
    }
}

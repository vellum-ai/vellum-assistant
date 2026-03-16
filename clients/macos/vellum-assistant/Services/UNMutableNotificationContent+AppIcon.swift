import AppKit
import Foundation
import UserNotifications

/// Caches the rendered notification icon on disk so we don't re-render on every notification.
/// Invalidated when the avatar changes by updating the mod-date check.
private let notificationIconCacheURL: URL = {
    let tmp = FileManager.default.temporaryDirectory
        .appendingPathComponent("com.vellum.vellum-assistant", isDirectory: true)
    try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    return tmp.appendingPathComponent("notification-icon.png")
}()

/// Tracks the avatar source mod-date so we know when to re-render.
private var cachedAvatarModDate: Date?

extension UNMutableNotificationContent {
    /// Attaches the assistant's avatar (with squircle mask matching the dock icon)
    /// to the notification content. Falls back to the static AppIcon.icns when
    /// no custom avatar is set.
    @MainActor
    func attachAppIcon() {
        // Try custom avatar first
        if let url = avatarNotificationIconURL() {
            // UNNotificationAttachment moves the file, so copy to a unique path per notification.
            let uniqueURL = url.deletingLastPathComponent()
                .appendingPathComponent(UUID().uuidString + ".png")
            if let _ = try? FileManager.default.copyItem(at: url, to: uniqueURL),
               let attachment = try? UNNotificationAttachment(
                identifier: "app-icon",
                url: uniqueURL,
                options: [UNNotificationAttachmentOptionsTypeHintKey: "public.png"]
            ) {
                attachments = [attachment]
                return
            }
        }

        // Fall back to static bundle icon
        guard let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns")
                ?? Bundle(identifier: "com.vellum.vellum-assistant")?.url(forResource: "AppIcon", withExtension: "icns"),
              let attachment = try? UNNotificationAttachment(identifier: "app-icon", url: iconURL, options: nil)
        else { return }
        attachments = [attachment]
    }

    /// Returns a file URL to the squircle-masked avatar PNG for use as a notification
    /// attachment, or nil if no custom avatar is set.
    @MainActor
    private func avatarNotificationIconURL() -> URL? {
        let manager = AvatarAppearanceManager.shared
        guard let avatar = manager.customAvatarImage else { return nil }

        // Check if the cached file is still valid by comparing the avatar source mod-date.
        let avatarURL = AvatarAppearanceManager.workspaceCustomAvatarURL()
        let currentModDate = (try? FileManager.default.attributesOfItem(atPath: avatarURL.path))?[.modificationDate] as? Date

        if FileManager.default.fileExists(atPath: notificationIconCacheURL.path),
           let currentModDate, let cachedDate = cachedAvatarModDate,
           currentModDate == cachedDate {
            return notificationIconCacheURL
        }

        // Render the avatar with the same squircle mask as the dock icon.
        let size: CGFloat = 256
        let square = AvatarAppearanceManager.resizedImage(avatar, to: size)
        let iconSize = NSSize(width: size, height: size)
        let icon = NSImage(size: iconSize)
        icon.lockFocus()

        let rect = NSRect(origin: .zero, size: iconSize)
        let radius = size * 0.23
        let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        path.addClip()

        square.draw(in: rect, from: NSRect(origin: .zero, size: square.size),
                    operation: .copy, fraction: 1.0)

        icon.unlockFocus()

        // Write to a temp file (UNNotificationAttachment requires a file URL).
        guard let tiffData = icon.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:]) else {
            return nil
        }

        do {
            try pngData.write(to: notificationIconCacheURL)
            cachedAvatarModDate = currentModDate
            return notificationIconCacheURL
        } catch {
            return nil
        }
    }
}

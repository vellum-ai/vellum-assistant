import AppKit
import Foundation
import UserNotifications
import VellumAssistantShared

/// Temporary directory for rendered notification icon.
private let notificationIconCacheURL: URL = {
    let tmp = FileManager.default.temporaryDirectory
        .appendingPathComponent(Bundle.appBundleIdentifier, isDirectory: true)
    try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    return tmp.appendingPathComponent("notification-icon.png")
}()

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
                ?? Bundle(identifier: Bundle.appBundleIdentifier)?.url(forResource: "AppIcon", withExtension: "icns"),
              let attachment = try? UNNotificationAttachment(identifier: "app-icon", url: iconURL, options: nil)
        else { return }
        attachments = [attachment]
    }

    /// Returns a file URL to the squircle-masked avatar PNG for use as a notification
    /// attachment, or nil if no custom avatar is set.
    /// Always re-renders — notifications are infrequent so the cost is negligible.
    @MainActor
    private func avatarNotificationIconURL() -> URL? {
        let manager = AvatarAppearanceManager.shared
        guard let avatar = manager.customAvatarImage else { return nil }

        let size: CGFloat = 256
        let icon = AvatarAppearanceManager.squircleIcon(avatar, size: size)

        // Render directly into a 2x bitmap — no TIFF intermediate.
        let px = Int(size) * 2
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }
        bitmap.size = NSSize(width: size, height: size)

        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        icon.draw(in: NSRect(origin: .zero, size: NSSize(width: size, height: size)),
                  from: .zero, operation: .copy, fraction: 1.0)

        guard let pngData = bitmap.representation(using: .png, properties: [:]) else { return nil }

        do {
            try pngData.write(to: notificationIconCacheURL)
            return notificationIconCacheURL
        } catch {
            return nil
        }
    }
}
